package jforex;

import com.dukascopy.api.Configurable;
import com.dukascopy.api.Filter;
import com.dukascopy.api.IAccount;
import com.dukascopy.api.IBar;
import com.dukascopy.api.IConsole;
import com.dukascopy.api.IContext;
import com.dukascopy.api.IHistory;
import com.dukascopy.api.IMessage;
import com.dukascopy.api.IStrategy;
import com.dukascopy.api.ITick;
import com.dukascopy.api.Instrument;
import com.dukascopy.api.OfferSide;
import com.dukascopy.api.Period;

import java.io.BufferedWriter;
import java.io.File;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * ForexEdge roadmap step 2: exports Dukascopy one-minute BID and ASK bars to CSV
 * through the official JForex strategy API (IHistory.getBars). Run it locally in
 * JForex 4 (a demo login is enough). It places no orders. See README.md.
 *
 * Output goes under the strategy files folder (context.getFilesDir(), normally
 * Documents/JForex/Strategies/files):
 *
 *   forexedge-m1/EURUSD/2015.csv            full year (months 1-12)
 *   forexedge-m1/XAUUSD/2010-01_01.csv      partial range (here: January only)
 *   forexedge-m1/EURUSD/2015.gaps.txt       only if minutes are missing
 *
 *   time_ms,bid_open,bid_high,bid_low,bid_close,bid_volume,ask_open,ask_high,ask_low,ask_close,ask_volume
 *
 * - time_ms is the bar START in epoch milliseconds (UTC), so no platform timezone
 *   setting can change the file.
 * - Filter.NO_FILTER: every minute is requested, including flat (zero-volume)
 *   minutes, so a complete file has exactly one row per minute of the range. The
 *   ForexEdge importer decides which minutes are real bars.
 * - If the feed returns fewer minutes than the range holds, the missing ranges are
 *   written to <name>.gaps.txt next to the CSV so they can be reviewed. Nothing is
 *   filled in.
 * - BID and ASK lists for the same range must line up bar for bar; a month where
 *   they don't fails the export instead of writing a misaligned row.
 * - Files are written as <name>.csv.part and renamed when complete. Finished files
 *   are skipped, so stopping and restarting the strategy resumes.
 */
public class ForexEdgeM1Export implements IStrategy {

    @Configurable("Instruments (comma-separated JForex names)")
    public String instruments = "EURUSD,GBPUSD,USDJPY,XAUUSD";

    @Configurable("From year (inclusive)")
    public int fromYear = 2010;

    @Configurable("To year (inclusive)")
    public int toYear = 2022;

    @Configurable("From month 1-12 (inclusive, applies to every year)")
    public int fromMonth = 1;

    @Configurable("To month 1-12 (inclusive, applies to every year)")
    public int toMonth = 12;

    private static final String HEADER =
        "time_ms,bid_open,bid_high,bid_low,bid_close,bid_volume,ask_open,ask_high,ask_low,ask_close,ask_volume";
    private static final long MINUTE_MS = 60_000L;

    private IContext context;
    private IHistory history;
    private IConsole console;
    private volatile boolean stopRequested;

    @Override
    public void onStart(IContext context) {
        this.context = context;
        this.history = context.getHistory();
        this.console = context.getConsole();

        if (fromMonth < 1 || toMonth > 12 || fromMonth > toMonth || fromYear > toYear) {
            fail("Invalid range: years " + fromYear + "-" + toYear + ", months " + fromMonth + "-" + toMonth);
            context.stop();
            return;
        }

        Set<Instrument> selected = new LinkedHashSet<>();
        for (String name : instruments.split(",")) {
            Instrument instrument;
            try {
                instrument = Instrument.valueOf(name.trim());
            } catch (IllegalArgumentException e) {
                instrument = null;
            }
            if (instrument == null) {
                fail("Unknown instrument: " + name.trim());
                context.stop();
                return;
            }
            selected.add(instrument);
        }
        context.setSubscribedInstruments(selected, true);

        File root = new File(context.getFilesDir(), "forexedge-m1");
        log("Exporting " + selected + " years " + fromYear + "-" + toYear + ", months " + fromMonth + "-" + toMonth
            + " to " + root.getAbsolutePath());

        // getBars blocks while history downloads, so the long export runs on its own
        // thread and hands each API call back to the strategy thread (executeTask).
        // That keeps the platform responsive and lets Stop take effect between months.
        Thread worker = new Thread(() -> exportAll(selected, root), "forexedge-m1-export");
        worker.setDaemon(true);
        worker.start();
    }

    private void exportAll(Set<Instrument> selected, File root) {
        try {
            for (Instrument instrument : selected) {
                for (int year = fromYear; year <= toYear && !stopRequested; year++) {
                    exportRange(instrument, year, root);
                }
            }
            log(stopRequested ? "Stopped; run again to resume." : "Export complete.");
        } catch (Exception e) {
            fail("Export failed: " + e);
        } finally {
            if (!stopRequested) {
                context.stop();
            }
        }
    }

    // A full year is named <year>; a partial range <year>-<from>_<to>, so a short
    // calibration run can never be mistaken for (or skip) a full year.
    private String baseName(int year) {
        return fromMonth == 1 && toMonth == 12
            ? String.valueOf(year)
            : String.format("%d-%02d_%02d", year, fromMonth, toMonth);
    }

    private void exportRange(Instrument instrument, int year, File root) throws Exception {
        File dir = new File(root, instrument.name());
        String base = baseName(year);
        File done = new File(dir, base + ".csv");
        File gapsFile = new File(dir, base + ".gaps.txt");
        if (done.exists()) {
            log(instrument + " " + base + ": already exported, skipping");
            return;
        }
        Files.createDirectories(dir.toPath());
        Files.deleteIfExists(gapsFile.toPath());
        File part = new File(dir, base + ".csv.part");

        long rangeStart = monthStart(year, fromMonth);
        long rangeEnd = monthStart(year, toMonth + 1); // exclusive
        long expectedRows = (rangeEnd - rangeStart) / MINUTE_MS;

        long started = System.currentTimeMillis();
        long rows = 0;
        long nextExpected = rangeStart;
        List<String> gaps = new ArrayList<>();
        int decimals = instrument.getPipScale() + 1;

        try (BufferedWriter out = Files.newBufferedWriter(part.toPath(), StandardCharsets.UTF_8)) {
            out.write(HEADER);
            out.write('\n');
            for (int month = fromMonth; month <= toMonth; month++) {
                if (stopRequested) {
                    return; // .part is left behind and rewritten on the next run
                }
                long from = monthStart(year, month);
                long to = monthStart(year, month + 1) - MINUTE_MS;
                List<IBar[]> pairs = context.executeTask(() -> monthBars(instrument, from, to)).get();
                for (IBar[] pair : pairs) {
                    long time = pair[0].getTime();
                    if (time < nextExpected) {
                        throw new IllegalStateException(instrument + ": bar " + iso(time)
                            + " is out of order or duplicated (expected " + iso(nextExpected) + ")");
                    }
                    if (time > nextExpected) {
                        gaps.add(gapLine(nextExpected, time));
                    }
                    out.write(row(pair[0], pair[1], decimals));
                    out.write('\n');
                    nextExpected = time + MINUTE_MS;
                    rows++;
                }
            }
        }
        if (nextExpected < rangeEnd) {
            gaps.add(gapLine(nextExpected, rangeEnd));
        }

        Files.move(part.toPath(), done.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        long seconds = (System.currentTimeMillis() - started) / 1000;
        if (rows == expectedRows) {
            log(String.format("%s %s: %d rows in %ds", instrument, base, rows, seconds));
        } else {
            writeGaps(gapsFile, instrument, base, rows, expectedRows, gaps);
            fail(String.format("%s %s: %d rows in %ds, expected %d; %d gap(s) written to %s",
                instrument, base, rows, seconds, expectedRows, gaps.size(), gapsFile.getName()));
        }
    }

    // Runs on the strategy thread (JForex API calls belong there).
    private List<IBar[]> monthBars(Instrument instrument, long from, long to) throws Exception {
        List<IBar> bid = history.getBars(instrument, Period.ONE_MIN, OfferSide.BID, Filter.NO_FILTER, from, to);
        List<IBar> ask = history.getBars(instrument, Period.ONE_MIN, OfferSide.ASK, Filter.NO_FILTER, from, to);
        if (bid.size() != ask.size()) {
            throw new IllegalStateException(instrument + " " + iso(from) + ": " + bid.size() + " bid bars vs "
                + ask.size() + " ask bars");
        }
        List<IBar[]> pairs = new ArrayList<>(bid.size());
        for (int i = 0; i < bid.size(); i++) {
            IBar b = bid.get(i);
            IBar a = ask.get(i);
            if (b.getTime() != a.getTime()) {
                throw new IllegalStateException(instrument + ": bid/ask misaligned at " + iso(b.getTime())
                    + " vs " + iso(a.getTime()));
            }
            pairs.add(new IBar[] { b, a });
        }
        return pairs;
    }

    private static String row(IBar b, IBar a, int decimals) {
        return b.getTime()
            + "," + price(b.getOpen(), decimals) + "," + price(b.getHigh(), decimals)
            + "," + price(b.getLow(), decimals) + "," + price(b.getClose(), decimals)
            + "," + volume(b.getVolume())
            + "," + price(a.getOpen(), decimals) + "," + price(a.getHigh(), decimals)
            + "," + price(a.getLow(), decimals) + "," + price(a.getClose(), decimals)
            + "," + volume(a.getVolume());
    }

    private static void writeGaps(File file, Instrument instrument, String base, long rows, long expected,
                                  List<String> gaps) throws Exception {
        try (BufferedWriter out = Files.newBufferedWriter(file.toPath(), StandardCharsets.UTF_8)) {
            out.write("# " + instrument + " " + base + ": " + rows + " rows, expected " + expected
                + " (" + (expected - rows) + " missing minutes)\n");
            out.write("# first_missing_utc,last_missing_utc,minutes\n");
            for (String gap : gaps) {
                out.write(gap);
                out.write('\n');
            }
        }
    }

    // Missing minutes are [fromInclusive, toExclusive).
    private static String gapLine(long fromInclusive, long toExclusive) {
        return iso(fromInclusive) + "," + iso(toExclusive - MINUTE_MS) + "," + (toExclusive - fromInclusive) / MINUTE_MS;
    }

    private static long monthStart(int year, int month) {
        return LocalDate.of(year, 1, 1).plusMonths(month - 1L).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli();
    }

    private static String iso(long millis) {
        return Instant.ofEpochMilli(millis).toString();
    }

    // Prices are quoted one digit past the pip; rounding removes binary noise
    // such as 1.4326499999 without changing the quoted value.
    private static String price(double value, int decimals) {
        return BigDecimal.valueOf(value).setScale(decimals, RoundingMode.HALF_UP).toPlainString();
    }

    private static String volume(double value) {
        return BigDecimal.valueOf(value).setScale(6, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString();
    }

    private void log(String message) {
        console.getOut().println("[forexedge-m1] " + message);
    }

    private void fail(String message) {
        console.getErr().println("[forexedge-m1] " + message);
    }

    @Override
    public void onStop() {
        stopRequested = true;
    }

    @Override
    public void onTick(Instrument instrument, ITick tick) {
    }

    @Override
    public void onBar(Instrument instrument, Period period, IBar askBar, IBar bidBar) {
    }

    @Override
    public void onMessage(IMessage message) {
    }

    @Override
    public void onAccount(IAccount account) {
    }
}
