import { cents } from '../../core/index';
import type {
  Broker,
  CancelOrderRequest,
  CancelOrderResponse,
  GetAccountRequest,
  GetAccountResponse,
  GetBrokerPositionsRequest,
  GetBrokerPositionsResponse,
  GetOrderRequest,
  GetOrderResponse,
  Order,
  SubmitOrderRequest,
  SubmitOrderResponse,
} from '../broker';

/**
 * Backtest broker: fills limit orders instantly at the limit price.
 * TODO(backtester): realistic fill model — mid +/- a fraction of the half
 * spread per leg, next-bar fills, partial fills, assignment at expiry.
 */
export class SimBroker implements Broker {
  private readonly positions = new Map<string, number>();
  private readonly orders = new Map<string, Order>();
  private seq = 0;

  async getAccount(_request: GetAccountRequest): Promise<GetAccountResponse> {
    return {
      account: { equityCents: cents(0), buyingPowerCents: cents(0), optionsLevel: 3 },
    };
  }

  async getPositions(_request: GetBrokerPositionsRequest): Promise<GetBrokerPositionsResponse> {
    return {
      positions: [...this.positions.entries()]
        .filter(([, qty]) => qty !== 0)
        .map(([symbol, qty]) => ({ symbol, qty, isOption: symbol.length > 6 })),
    };
  }

  async submitOrder({ order }: SubmitOrderRequest): Promise<SubmitOrderResponse> {
    for (const existing of this.orders.values()) {
      if (existing.clientOrderId === order.clientOrderId) return { order: existing };
    }
    for (const leg of order.legs) {
      const signed = leg.side === 'buy' ? leg.qty : -leg.qty;
      this.positions.set(leg.symbol, (this.positions.get(leg.symbol) ?? 0) + signed);
    }
    const filled: Order = {
      id: `sim-${++this.seq}`,
      clientOrderId: order.clientOrderId,
      status: 'filled',
      filledQty: order.legs[0]?.qty ?? 0,
    };
    this.orders.set(filled.id, filled);
    return { order: filled };
  }

  async getOrder({ orderId }: GetOrderRequest): Promise<GetOrderResponse> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown order: ${orderId}`);
    return { order };
  }

  async cancelOrder(_request: CancelOrderRequest): Promise<CancelOrderResponse> {
    // Instant fills -> nothing pending to cancel.
    return {};
  }
}
