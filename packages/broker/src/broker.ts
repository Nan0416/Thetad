import type { Cents } from '@thetad/core';

export interface Account {
  readonly equityCents: Cents;
  readonly buyingPowerCents: Cents;
  readonly optionsLevel: number;
}

export interface BrokerPosition {
  readonly symbol: string;
  /** Shares for equities, contracts for options; negative = short. */
  readonly qty: number;
  readonly isOption: boolean;
}

export type OrderSide = 'buy' | 'sell';
export type OrderStatus =
  'accepted' | 'new' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired';

export interface OrderLeg {
  readonly symbol: string;
  readonly side: OrderSide;
  readonly qty: number;
}

export interface OrderTicket {
  /** Idempotency key — always set, so an accidental double-submit dedupes broker-side. */
  readonly clientOrderId: string;
  readonly legs: readonly OrderLeg[];
  readonly type: 'market' | 'limit';
  /** For multi-leg orders this is the net debit (+) / credit (-) per share. */
  readonly limitPriceCents?: Cents;
  readonly timeInForce: 'day';
}

export interface Order {
  readonly id: string;
  readonly clientOrderId: string;
  readonly status: OrderStatus;
  readonly filledQty: number;
}

/*
 * Every client method takes exactly one Request object and returns exactly
 * one Response object, even when either is empty — uniform call shape, and
 * adding a field later never breaks a signature.
 */

export interface GetAccountRequest {}
export interface GetAccountResponse {
  readonly account: Account;
}

export interface GetBrokerPositionsRequest {}
export interface GetBrokerPositionsResponse {
  readonly positions: readonly BrokerPosition[];
}

export interface SubmitOrderRequest {
  readonly order: OrderTicket;
}
export interface SubmitOrderResponse {
  readonly order: Order;
}

export interface GetOrderRequest {
  readonly orderId: string;
}
export interface GetOrderResponse {
  readonly order: Order;
}

export interface CancelOrderRequest {
  readonly orderId: string;
}
export interface CancelOrderResponse {}

/**
 * The one seam between thetad and any broker. Implementations: Alpaca live,
 * Alpaca paper (same client, different keys/base URL), and the backtest sim.
 */
export interface Broker {
  getAccount(request: GetAccountRequest): Promise<GetAccountResponse>;
  getPositions(request: GetBrokerPositionsRequest): Promise<GetBrokerPositionsResponse>;
  submitOrder(request: SubmitOrderRequest): Promise<SubmitOrderResponse>;
  getOrder(request: GetOrderRequest): Promise<GetOrderResponse>;
  cancelOrder(request: CancelOrderRequest): Promise<CancelOrderResponse>;
}
