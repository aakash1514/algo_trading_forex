'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAppSelector } from '../../store';
import { useCreateOrderMutation } from '../../store/api/order.api';
import { useGetPipValueQuery } from '../../store/api/domain.api';
import { PAIR_DISPLAY } from '../../lib/constants';
import { cn } from '../../lib/cn';

const orderSchema = z.object({
  lots: z.number().min(0.01).max(100),
  stopLoss: z.number().optional(),
  takeProfit: z.number().optional(),
});

type OrderFormData = z.infer<typeof orderSchema>;

export function OrderForm() {
  const [direction, setDirection] = useState<'BUY' | 'SELL'>('BUY');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const activePair = useAppSelector((s) => s.market.activePair);
  const [createOrder, { isLoading }] = useCreateOrderMutation();

  const { register, handleSubmit, watch, reset, formState: { errors } } = useForm<OrderFormData>({
    resolver: zodResolver(orderSchema),
    defaultValues: { lots: 0.1 },
  });

  const lots = watch('lots') || 0.1;

  const { data: pipValue } = useGetPipValueQuery(
    { pair: activePair, lots, accountCurrency: 'USD' },
    { skip: !activePair || lots <= 0 }
  );

  async function onSubmit(data: OrderFormData) {
    setSubmitError(null);
    setSubmitSuccess(false);
    try {
      await createOrder({
        instrument: activePair,
        direction,
        orderType: 'MARKET',
        lots: data.lots,
        stopLoss: data.stopLoss,
        takeProfit: data.takeProfit,
      }).unwrap();
      setSubmitSuccess(true);
      reset({ lots: 0.1 });
      setTimeout(() => setSubmitSuccess(false), 2000);
    } catch (err: any) {
      setSubmitError(err?.data?.message ?? 'Order failed');
    }
  }

  return (
    <div className="p-3 border-b border-terminal-border">
      <p className="text-[10px] font-medium text-terminal-muted uppercase tracking-wider mb-3">
        New order · {PAIR_DISPLAY[activePair] ?? activePair}
      </p>

      {/* Buy / Sell toggle */}
      <div className="grid grid-cols-2 gap-1.5 mb-3">
        <button
          onClick={() => setDirection('BUY')}
          className={cn(
            'py-2 rounded text-[12px] font-medium transition-all',
            direction === 'BUY'
              ? 'bg-accent-green text-[#0a1a0f] border border-accent-green'
              : 'bg-accent-green/5 text-accent-green border border-accent-green/20 hover:bg-accent-green/10'
          )}
        >
          Buy
        </button>
        <button
          onClick={() => setDirection('SELL')}
          className={cn(
            'py-2 rounded text-[12px] font-medium transition-all',
            direction === 'SELL'
              ? 'bg-accent-red text-white border border-accent-red'
              : 'bg-accent-red/5 text-accent-red border border-accent-red/20 hover:bg-accent-red/10'
          )}
        >
          Sell
        </button>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-2">
        {/* Lots */}
        <div>
          <label className="block text-[9px] text-terminal-muted uppercase tracking-wider mb-1">Lots</label>
          <input
            {...register('lots', { valueAsNumber: true })}
            type="number"
            step="0.01"
            className={cn(
              'w-full bg-terminal-elevated border rounded px-2.5 py-1.5 text-[12px] text-[#e2e4e9] tabular-nums',
              'focus:outline-none focus:border-accent-blue transition-colors',
              errors.lots ? 'border-accent-red' : 'border-terminal-border'
            )}
          />
        </div>

        {/* SL / TP */}
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <label className="block text-[9px] text-terminal-muted uppercase tracking-wider mb-1">Stop loss</label>
            <input
              {...register('stopLoss', { valueAsNumber: true })}
              type="number"
              step="0.00001"
              placeholder="—"
              className="w-full bg-terminal-elevated border border-terminal-border rounded px-2.5 py-1.5 text-[12px] text-[#e2e4e9] tabular-nums placeholder:text-terminal-muted/40 focus:outline-none focus:border-accent-blue transition-colors"
            />
          </div>
          <div>
            <label className="block text-[9px] text-terminal-muted uppercase tracking-wider mb-1">Take profit</label>
            <input
              {...register('takeProfit', { valueAsNumber: true })}
              type="number"
              step="0.00001"
              placeholder="—"
              className="w-full bg-terminal-elevated border border-terminal-border rounded px-2.5 py-1.5 text-[12px] text-[#e2e4e9] tabular-nums placeholder:text-terminal-muted/40 focus:outline-none focus:border-accent-blue transition-colors"
            />
          </div>
        </div>

        {/* Pip value info */}
        {pipValue && (
          <div className="flex justify-between items-center bg-terminal-elevated rounded px-2.5 py-1.5">
            <span className="text-[9px] text-terminal-muted uppercase tracking-wider">Pip value</span>
            <span className="text-[11px] text-[#e2e4e9] tabular-nums font-medium">
              ${pipValue.pipValue.toFixed(2)}
            </span>
          </div>
        )}

        {submitError && (
          <p className="text-[11px] text-accent-red bg-accent-red/10 rounded px-2.5 py-1.5">
            {submitError}
          </p>
        )}

        <button
          type="submit"
          disabled={isLoading || submitSuccess}
          className={cn(
            'w-full py-2 rounded text-[12px] font-medium transition-all',
            submitSuccess
              ? 'bg-accent-green/20 text-accent-green border border-accent-green/30'
              : direction === 'BUY'
              ? 'bg-accent-blue/10 text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/20'
              : 'bg-accent-red/10 text-accent-red border border-accent-red/30 hover:bg-accent-red/20',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {submitSuccess ? '✓ Order placed' : isLoading ? 'Placing...' : `Place ${direction.toLowerCase()} order`}
        </button>
      </form>
    </div>
  );
}