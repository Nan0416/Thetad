import { fromUsd, toUsd } from '@thetad/core';
import { AlpacaHttp } from '@thetad/data';
import { z } from 'zod';
import type { Account, Broker, BrokerPosition, Order, OrderRequest, OrderStatus } from '../broker';

const accountSchema = z.object({
  equity: z.string(),
  buying_power: z.string(),
  options_trading_level: z.number().nullish(),
});

const positionSchema = z.object({
  symbol: z.string(),
  qty: z.string(),
  asset_class: z.string(),
});

const orderSchema = z.object({
  id: z.string(),
  client_order_id: z.string(),
  status: z.string(),
  filled_qty: z.string().nullish(),
});

function toOrder(raw: z.infer<typeof orderSchema>): Order {
  return {
    id: raw.id,
    clientOrderId: raw.client_order_id,
    status: raw.status as OrderStatus,
    filledQty: Number(raw.filled_qty ?? '0'),
  };
}

/** Alpaca trading API (paper or live decided purely by baseUrl + keys). */
export class AlpacaBroker implements Broker {
  constructor(private readonly http: AlpacaHttp) {}

  async getAccount(): Promise<Account> {
    const raw = await this.http.request(accountSchema, 'GET', '/v2/account');
    return {
      equityCents: fromUsd(Number(raw.equity)),
      buyingPowerCents: fromUsd(Number(raw.buying_power)),
      optionsLevel: raw.options_trading_level ?? 0,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const raw = await this.http.request(z.array(positionSchema), 'GET', '/v2/positions');
    return raw.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      isOption: p.asset_class === 'us_option',
    }));
  }

  async submitOrder(request: OrderRequest): Promise<Order> {
    const multiLeg = request.legs.length > 1;
    const body: Record<string, unknown> = {
      client_order_id: request.clientOrderId,
      type: request.type,
      time_in_force: request.timeInForce,
      ...(request.limitPriceCents !== undefined && {
        limit_price: String(toUsd(request.limitPriceCents)),
      }),
    };
    if (multiLeg) {
      body.order_class = 'mleg';
      body.qty = '1';
      body.legs = request.legs.map((leg) => ({
        symbol: leg.symbol,
        side: leg.side,
        ratio_qty: String(leg.qty),
      }));
    } else {
      const leg = request.legs[0]!;
      body.symbol = leg.symbol;
      body.side = leg.side;
      body.qty = String(leg.qty);
    }
    const raw = await this.http.request(orderSchema, 'POST', '/v2/orders', { body });
    return toOrder(raw);
  }

  async getOrder(id: string): Promise<Order> {
    return toOrder(await this.http.request(orderSchema, 'GET', `/v2/orders/${id}`));
  }

  async cancelOrder(id: string): Promise<void> {
    await this.http.request(z.unknown(), 'DELETE', `/v2/orders/${id}`);
  }
}
