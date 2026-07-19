import { fromUsd, toUsd } from '../../core/index';
import { AlpacaHttp } from '../../data/providers/alpaca/http';
import { z } from 'zod';
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
  OrderStatus,
  SubmitOrderRequest,
  SubmitOrderResponse,
} from '../broker';

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

  async getAccount(_request: GetAccountRequest): Promise<GetAccountResponse> {
    const raw = await this.http.request(accountSchema, 'GET', '/v2/account');
    return {
      account: {
        equityCents: fromUsd(Number(raw.equity)),
        buyingPowerCents: fromUsd(Number(raw.buying_power)),
        optionsLevel: raw.options_trading_level ?? 0,
      },
    };
  }

  async getPositions(_request: GetBrokerPositionsRequest): Promise<GetBrokerPositionsResponse> {
    const raw = await this.http.request(z.array(positionSchema), 'GET', '/v2/positions');
    return {
      positions: raw.map((p) => ({
        symbol: p.symbol,
        qty: Number(p.qty),
        isOption: p.asset_class === 'us_option',
      })),
    };
  }

  async submitOrder({ order }: SubmitOrderRequest): Promise<SubmitOrderResponse> {
    const multiLeg = order.legs.length > 1;
    const body: Record<string, unknown> = {
      client_order_id: order.clientOrderId,
      type: order.type,
      time_in_force: order.timeInForce,
      ...(order.limitPriceCents !== undefined && {
        limit_price: String(toUsd(order.limitPriceCents)),
      }),
    };
    if (multiLeg) {
      body.order_class = 'mleg';
      body.qty = '1';
      body.legs = order.legs.map((leg) => ({
        symbol: leg.symbol,
        side: leg.side,
        ratio_qty: String(leg.qty),
      }));
    } else {
      const leg = order.legs[0]!;
      body.symbol = leg.symbol;
      body.side = leg.side;
      body.qty = String(leg.qty);
    }
    const raw = await this.http.request(orderSchema, 'POST', '/v2/orders', { body });
    return { order: toOrder(raw) };
  }

  async getOrder({ orderId }: GetOrderRequest): Promise<GetOrderResponse> {
    const raw = await this.http.request(orderSchema, 'GET', `/v2/orders/${orderId}`);
    return { order: toOrder(raw) };
  }

  async cancelOrder({ orderId }: CancelOrderRequest): Promise<CancelOrderResponse> {
    await this.http.request(z.unknown(), 'DELETE', `/v2/orders/${orderId}`);
    return {};
  }
}
