import type { OrderItem } from './payments.types';

export interface CheckoutBlock {
  provider: string;
  keyId: string;
  gatewayOrderId: string;
  /** Same value as `gatewayOrderId`, in the gateway's own spelling. */
  order_id: string;
  name: string;
  description: string;
  methods: string[];
  upiIntentUrl: string | null;
  qrPayload: string | null;
  prefill: { contact: string | null };
}

export interface OrderLine {
  label: string;
  amountPaise: number;
}

export interface PaymentOrderDto {
  id: number;
  societyId: number;
  unitId: number;
  sourceType: string;
  status: string;
  basePaise: number;
  convenienceFeePaise: number;
  convenienceFeeGstPaise: number;
  grossAmountPaise: number;
  expiresAt: Date;
  paidAt: Date | null;
  gatewayOrderId: string | null;
  refType: string | null;
  refId: number | null;
  items: OrderItem[];
}
