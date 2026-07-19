import type { Cents } from '@thetad/core';

export interface Account {
  equityCents: Cents;
  buyingPowerCents: Cents;
  optionsLevel: number;
}

export interface BrokerPosition {
  symbol: string;
  /** Shares for equities, contracts for options; negative = short. */
  qty: number;
  isOption: boolean;
}

export type OrderSide = 'buy' | 'sell';
export type OrderStatus =
  | 'accepted'
  | 'new'
  | 'partially_filled'
  | 'filled'
  | 'canceled'
  | 'rejected'
  | 'expired';

export interface OrderLeg {
  symbol: string;
  side: OrderSide;
  qty: number;
}

export interface OrderRequest {
  /** Idempotency key — always set, so an accidental double-submit dedupes broker-side. */
  clientOrderId: string;
  legs: OrderLeg[];
  type: 'market' | 'limit';
  /** For multi-leg orders this is the net debit (+) / credit (-) per share. */
  limitPriceCents?: Cents;
  timeInForce: 'day';
}

export interface Order {
  id: string;
  clientOrderId: string;
  status: OrderStatus;
  filledQty: number;
}

/**
 * The one seam between thetad and any broker. Implementations: Alpaca live,
 * Alpaca paper (same client, different keys/base URL), and the backtest sim.
 */
export interface Broker {
  getAccount(): Promise<Account>;
  getPositions(): Promise<BrokerPosition[]>;
  submitOrder(request: OrderRequest): Promise<Order>;
  getOrder(id: string): Promise<Order>;
  cancelOrder(id: string): Promise<void>;
}
