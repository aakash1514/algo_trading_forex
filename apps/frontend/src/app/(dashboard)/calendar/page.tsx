import { Metadata } from 'next';
import { CalendarClient } from '../../../components/widgets/CalendarClient';

export const metadata: Metadata = {
  title: 'Economic Calendar — ForexEdge',
};

export default function CalendarPage() {
  return <CalendarClient />;
}