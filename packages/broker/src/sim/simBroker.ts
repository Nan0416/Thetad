import { cents } from '@thetad/core';
import type { Account, Broker, BrokerPosition, Order, OrderRequest } from '../broker';

/**
 * Backtest broker: fills limit orders instantly at the limit price.
 * TODO(backtester): realistic fill model — mid +/- a fraction of the half
 * spread per leg, next-bar fills, partial fills, assignment at expiry.
 */
export class SimBroker implements Broker {
  private readonly positions = new Map<string, number>();
  private readonly orders = new Map<string, Order>();
  private seq = 0;

  async getAccount(): Promise<Account> {
    return {
      equityCents: cents(0),
      buyingPowerCents: cents(0),
      optionsLevel: 3,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return [...this.positions.entries()]
      .filter(([, qty]) => qty !== 0)
      .map(([symbol, qty]) => ({ symbol, qty, isOption: symbol.length > 6 }));
  }

  async submitOrder(request: OrderRequest): Promise<Order> {
    for (const existing of this.orders.values()) {
      if (existing.clientOrderId === request.clientOrderId) return existing;
    }
    for (const leg of request.legs) {
      const signed = leg.side === 'buy' ? leg.qty : -leg.qty;
      this.positions.set(leg.symbol, (this.positions.get(leg.symbol) ?? 0) + signed);
    }
    const order: Order = {
      id: `sim-${++this.seq}`,
      clientOrderId: request.clientOrderId,
      status: 'filled',
      filledQty: request.legs[0]?.qty ?? 0,
    };
    this.orders.set(order.id, order);
    return order;
  }

  async getOrder(id: string): Promise<Order> {
    const order = this.orders.get(id);
    if (!order) throw new Error(`unknown order: ${id}`);
    return order;
  }

  async cancelOrder(): Promise<void> {
    // Instant fills -> nothing pending to cancel.
  }
}
