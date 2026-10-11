export enum ForexSession {
  SYDNEY    = 'SYDNEY',
  TOKYO     = 'TOKYO',
  LONDON    = 'LONDON',
  NEW_YORK  = 'NEW_YORK',
}

export enum SessionEventType {
  SESSION_OPEN  = 'SESSION_OPEN',
  SESSION_CLOSE = 'SESSION_CLOSE',
}

export interface SessionWindow {
  session: ForexSession;
  openUtcHour: number;
  closeUtcHour: number;
}

export interface SessionStatus {
  session: ForexSession;
  isActive: boolean;
  opensAt?: string;   // ISO string of next open
  closesAt?: string;  // ISO string of next close
}

export interface CurrentSessionsResult {
  active: ForexSession[];
  inactive: ForexSession[];
  timestamp: string;
}

// The forex.sessions message type is SessionEventMessage in @forexedge/kafka.