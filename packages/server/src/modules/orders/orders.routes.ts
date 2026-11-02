import { Router, type Request } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { OrderResponse } from '@nayaro/shared';
import { readIdempotencyAttempt } from '../../utils/idempotency';
import { ApiError } from '../../utils/apiError';
import {
  requireAuthContext,
  requireRole,
  requireServicePermission,
} from '../../middleware/authentication';
import type { RealtimeEmitter } from '../../socket/realtimeEmitter';
import type { Logger } from '../../utils/logger';
import * as billingService from '../billing/billing.service';
import * as invoiceHistory from '../billing/invoiceHistory.service';
import * as printService from '../billing/print.service';
import * as kitchenService from '../kitchen/kitchen.service';
import * as menuService from '../menu/menu.service';
import * as paymentsService from '../payments/payments.service';
import * as ordersService from './orders.service';
import { auditFromRequest } from '../audit/audit.service';

export interface OrdersRouterDeps {
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
  readonly realtime: RealtimeEmitter;
}

/**
 * Order and menu routes.
 *
 * The same two rules as the floor: `restaurantId` comes from
 * `requireAuthContext(req)` and never from the request, and handlers contain
 * no Prisma - they read the session, call a service, announce, respond.
 *
 * Roles provide service presets. Extra staff duties may grant order taking
 * or kitchen transitions; billing, discounts and corrections remain role gated.
 */
/** Front of house needs to see the kitchen queue as much as the kitchen does. */
const CAN_SEE_KITCHEN = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const;
/**
 * A cashier's job is to bill customers, so billing is open to all three.
 *
 * WAITER is absent deliberately, and this is the line that defines the role.
 * A waiter may fill a table's order all evening and may not issue its bill,
 * take a payment or see the pre-bill total - that is the cashier's station,
 * and on the phone it simply is not offered.
 */
const CAN_BILL = ['OWNER', 'MANAGER', 'CASHIER'] as const;
/** Giving money away is not. See the discount route for the reasoning. */
const CAN_DISCOUNT = ['OWNER', 'MANAGER'] as const;
/**
 * CORRECTIONS. Owners and managers only - all four of them.
 *
 * Every correction in this phase either reduces what a customer is charged or
 * withdraws a financial document, and a cashier who can do that unsupervised
 * can take money out of the till and leave a tidy record behind. A KITCHEN
 * account has no void authority either: a cook who has been sent the wrong
 * ticket asks a manager, which is what happens in the room anyway. There is
 * deliberately no request-and-approve workflow - a fake one, where nobody
 * actually approves, would be worse than none.
 */
const CAN_CORRECT = ['OWNER', 'MANAGER'] as const;

export function createOrdersRouter(deps: OrdersRouterDeps): Router {
  const router = Router();

  router.get('/menu', requireServicePermission('TAKE_ORDERS'), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await menuService.getMenu(deps.prisma, staff.restaurantId));
  });

  router.get('/orders/:orderId', requireServicePermission('TAKE_ORDERS'), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(
      await ordersService.getOrder(deps.prisma, staff.restaurantId, pathParam(req, 'orderId')),
    );
  });

  /**
   * Open takeaways. Without this a takeaway becomes unreachable the moment a
   * cashier navigates away, because the floor plan only knows about tables.
   */
  router.get('/orders/takeaway/open', requireServicePermission('TAKE_ORDERS'), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await ordersService.listOpenTakeaways(deps.prisma, staff.restaurantId));
  });

  /** "What is on this table right now?" - `{ order: null }` is a normal answer. */
  router.get(
    '/tables/:tableId/order',
    requireServicePermission('TAKE_ORDERS'),
    async (req, res) => {
      const { staff } = requireAuthContext(req);
      res.json(
        await ordersService.getActiveOrderForTable(
          deps.prisma,
          staff.restaurantId,
          pathParam(req, 'tableId'),
        ),
      );
    },
  );

  /**
   * The only route that can create an Order, and it does so only as a
   * side effect of adding a real item. There is deliberately no
   * POST /orders: an endpoint that creates an empty order is an endpoint that
   * fills the database with mis-taps.
   */
  router.post('/orders/items', requireServicePermission('TAKE_ORDERS'), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const attempt = readIdempotencyAttempt(req);
    const result = await ordersService.addItem(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      req.body,
      attempt,
    );
    if (!attempt.replayed) announce(deps, staff.restaurantId, result, 'item added');
    res.status(201).json(result);
  });

  router.patch(
    '/orders/:orderId/items/:itemId',
    requireServicePermission('TAKE_ORDERS'),
    async (req, res) => {
      const { staff } = requireAuthContext(req);
      const result = await ordersService.updateItem(
        deps.prisma,
        staff.restaurantId,
        pathParam(req, 'orderId'),
        pathParam(req, 'itemId'),
        req.body,
      );
      announce(deps, staff.restaurantId, result, 'item changed');
      res.json(result);
    },
  );

  router.delete(
    '/orders/:orderId/items/:itemId',
    requireServicePermission('TAKE_ORDERS'),
    async (req, res) => {
      const { staff } = requireAuthContext(req);
      const orderId = pathParam(req, 'orderId');
      // Captured before the delete: if this was the last item the order is gone,
      // and the floor still needs to hear which table just came free.
      const before = await ordersService.getOrder(deps.prisma, staff.restaurantId, orderId);

      const result = await ordersService.removeItem(
        deps.prisma,
        staff.restaurantId,
        orderId,
        pathParam(req, 'itemId'),
        req.query,
      );

      deps.realtime.orderUpdated({
        restaurantId: staff.restaurantId,
        orderId,
        tableId: before.order.table?.id ?? null,
        deleted: result.order === null,
      });
      deps.logger.debug(
        result.order === null ? 'order:updated (order emptied)' : 'order:updated (item removed)',
      );
      res.json(result);
    },
  );

  /**
   * The ONLY way a KOT comes into existence. There is deliberately no
   * POST /kots: a generic create endpoint would let a client invent a ticket
   * with arbitrary quantities, and the delta arithmetic - the thing that stops
   * the kitchen cooking the same coke twice - would be the client's to get
   * right. Dispatch is a domain operation, so it is exposed as one.
   */
  router.post(
    '/orders/:orderId/send-kot',
    requireServicePermission('TAKE_ORDERS'),
    async (req, res) => {
      const { staff } = requireAuthContext(req);
      const orderId = pathParam(req, 'orderId');
      const attempt = readIdempotencyAttempt(req);
      const result = await ordersService.sendToKitchen(
        deps.prisma,
        staff.restaurantId,
        staff.id,
        orderId,
        req.body,
        attempt,
      );

      // Both events, after commit. They are not redundant: the kitchen board
      // listens for the new ticket, while the POS and the floor need to know the
      // order changed - it is now OPEN, and its table has turned PREPARING.
      if (!attempt.replayed) {
        deps.realtime.kotCreated({
          restaurantId: staff.restaurantId,
          kotId: result.kot.id,
          kotNumber: result.kot.kotNumber,
          orderId,
          tableId: result.order.table?.id ?? null,
        });
        announce(deps, staff.restaurantId, result, 'sent to kitchen');
        deps.realtime.menuUpdated({ restaurantId: staff.restaurantId });
      }
      res.status(201).json(result);
    },
  );

  router.post(
    '/orders/:orderId/transfer-table',
    requireServicePermission('TAKE_ORDERS'),
    async (req, res) => {
      const { staff } = requireAuthContext(req);
      const attempt = readIdempotencyAttempt(req);
      const result = await ordersService.transferTable(
        deps.prisma,
        staff.restaurantId,
        staff.id,
        pathParam(req, 'orderId'),
        req.body,
        attempt,
      );
      if (!attempt.replayed) {
        // Both tables and existing kitchen tickets must be read again. No new KOT or alarm.
        deps.realtime.floorUpdated({ restaurantId: staff.restaurantId });
        announce(deps, staff.restaurantId, result, 'table transferred');
      }
      res.json(result);
    },
  );

  /**
   * Readable by the whole floor, not just the kitchen. A cashier asked "is
   * table 6's food up yet?" twenty times a night, and the honest answer is on
   * this board. Mutating ticket status stays a kitchen/manager action and
   * arrives in Phase 4E - there is nothing to authorise here yet.
   */
  router.get('/kitchen/tickets', requireRole(...CAN_SEE_KITCHEN), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await kitchenService.getTickets(deps.prisma, staff.restaurantId));
  });

  /**
   * A state transition on an existing ticket, so PATCH on the ticket rather
   * than four action endpoints. The valid moves are a property of the ticket's
   * current status, not of the URL, and the server decides them - a client
   * asking for an illegal move gets INVALID_KOT_TRANSITION however it asked.
   *
   * Mutating is narrower than reading: the whole floor may watch the board, but
   * only the people who cook or manage may move a ticket along it. A CASHIER
   * with a hand-rolled request gets 403 exactly as one with a hidden button
   * would - the UI never carries this decision.
   */
  router.patch(
    '/kitchen/tickets/:kotId/status',
    requireServicePermission('MANAGE_KITCHEN'),
    async (req, res) => {
      const { staff } = requireAuthContext(req);
      const ticket = await kitchenService.transitionStatus(
        deps.prisma,
        staff.restaurantId,
        pathParam(req, 'kotId'),
        req.body,
      );

      // After commit. The board hears it; so does the floor, because a table's
      // colour is derived from its tickets - this is what turns Table 4 READY on
      // the cashier's screen the moment the kitchen plates the food.
      deps.realtime.kotUpdated({
        restaurantId: staff.restaurantId,
        kotId: ticket.id,
        orderId: ticket.orderId,
        tableId: null,
        status: ticket.status,
      });
      deps.logger.debug(`kot:updated (${ticket.status})`);
      res.json({ ticket });
    },
  );

  /**
   * Voids a ticket: "this batch was sent to the kitchen in error".
   *
   * An explicit action rather than a status PATCH, because it is not a move
   * along the kitchen workflow - it returns quantities to the undispatched
   * pool, needs a reason, and is authorised differently from every other
   * ticket change. There is no DELETE anywhere near a KOT.
   */
  router.post('/kitchen/tickets/:kotId/void', requireRole(...CAN_CORRECT), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const voided = await kitchenService.voidKot(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      pathParam(req, 'kotId'),
      req.body,
    );
    const result = await ordersService.getOrder(deps.prisma, staff.restaurantId, voided.orderId);

    // Both events, after commit. The board drops the ticket; the POS and floor
    // need the order, because its dispatched quantities and the table's colour
    // both just changed.
    deps.realtime.kotUpdated({
      restaurantId: staff.restaurantId,
      kotId: voided.kotId,
      orderId: voided.orderId,
      tableId: result.order.table?.id ?? null,
      status: 'VOID',
    });
    announce(deps, staff.restaurantId, result, 'ticket voided');
    res.json(result);
  });

  /**
   * Cancels dispatched units off the bill.
   *
   * A sub-resource create, not a PATCH on the item: the cancellation is a row
   * with its own actor, time and reason, and the item's ordered quantity is
   * deliberately not what changes. Undispatched units are edited with the
   * normal quantity route instead - the service refuses them here.
   */
  router.post(
    '/orders/:orderId/items/:itemId/cancellations',
    requireRole(...CAN_CORRECT),
    async (req, res) => {
      const { staff } = requireAuthContext(req);
      const result = await ordersService.cancelOrderItem(
        deps.prisma,
        staff.restaurantId,
        staff.id,
        pathParam(req, 'orderId'),
        pathParam(req, 'itemId'),
        req.body,
      );
      announce(deps, staff.restaurantId, result, 'item cancelled');
      res.status(201).json(result);
    },
  );

  /**
   * The billing screen's single read. Returns a live pre-bill, or the issued
   * invoice if one exists - never both, and never creates anything.
   */
  router.get('/orders/:orderId/billing', requireRole(...CAN_BILL), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(
      await billingService.getBilling(deps.prisma, staff.restaurantId, pathParam(req, 'orderId')),
    );
  });

  /**
   * The working discount.
   *
   * OWNER and MANAGER only. This is the one billing action a cashier cannot
   * take, because it is the one that gives money away - and the schema records
   * who approved it, which is only meaningful if the approver had the
   * authority. There is deliberately no request-approval flow yet: a fake one
   * (cashier proposes, nobody actually approves) would be worse than none.
   */
  router.patch('/orders/:orderId/discount', requireRole(...CAN_DISCOUNT), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const orderId = pathParam(req, 'orderId');
    const preBill = await billingService.setDiscount(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      orderId,
      req.body,
    );
    deps.realtime.orderUpdated({
      restaurantId: staff.restaurantId,
      orderId,
      tableId: null,
      deleted: false,
    });
    deps.logger.debug('order:updated (discount changed)');
    res.json({ preBill });
  });

  /**
   * Issues the invoice. Its own operation, separate from payment: a bill can
   * sit issued and unpaid for as long as the customer takes to find their
   * wallet, and conflating the two would make "issued" mean "settled".
   */
  router.post('/orders/:orderId/invoice', requireRole(...CAN_BILL), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const orderId = pathParam(req, 'orderId');
    const invoice = await billingService.issueInvoice(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      orderId,
      req.body,
    );

    // Both events, after commit. The floor turns AWAITING_PAYMENT because an
    // ACTIVE invoice outranks every kitchen state, and the POS needs to know
    // the order is now read-only.
    deps.realtime.invoiceIssued({
      restaurantId: staff.restaurantId,
      invoiceId: invoice.id,
      orderId,
      tableId: null,
    });
    deps.realtime.orderUpdated({
      restaurantId: staff.restaurantId,
      orderId,
      tableId: null,
      deleted: false,
    });
    deps.logger.debug(`invoice:issued (#${String(invoice.invoiceNumber)})`);
    res.status(201).json({ invoice });
  });

  /**
   * The bills list: every invoice in a business-date range, newest first.
   *
   * Open to whoever may bill, because "reprint last night's bill for table 4"
   * is a cashier's request. It reads only; reprinting and voiding go through
   * the existing per-invoice routes, with their own authority.
   */
  router.get('/invoices', requireRole(...CAN_BILL), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await invoiceHistory.listInvoices(deps.prisma, staff.restaurantId, req.query));
  });

  /**
   * Records money against an issued bill.
   *
   * A domain operation, not Payment CRUD. There is deliberately no
   * PATCH or DELETE for a payment anywhere in this API: payments are financial
   * history, and correcting one is a reversal with a reason attached - a
   * different feature, with different authority, for a later phase.
   */
  router.post('/invoices/:invoiceId/payments', requireRole(...CAN_BILL), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const attempt = readIdempotencyAttempt(req);
    const invoice = await paymentsService.recordPayment(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      pathParam(req, 'invoiceId'),
      req.body,
      attempt,
    );
    if (!attempt.replayed) announceSettlement(deps, staff.restaurantId, invoice);
    res.status(201).json({ invoice });
  });

  /**
   * Closes a bill that is genuinely for nothing, after a 100% discount.
   * Separate from recording a payment because there is no payment to record -
   * and `chk_payment_amount` would refuse a zero-amount row anyway.
   */
  router.post('/invoices/:invoiceId/settle', requireRole(...CAN_BILL), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const invoice = await paymentsService.settleZeroTotal(
      deps.prisma,
      staff.restaurantId,
      pathParam(req, 'invoiceId'),
      req.body,
    );
    announceSettlement(deps, staff.restaurantId, invoice);
    res.status(201).json({ invoice });
  });

  /**
   * Records that a bill went to a printer, and says which copy it is.
   *
   * A sub-resource create, because that is what it is: each print is a row
   * with its own actor and time, and the second one is a different thing from
   * the first. The renderer does the actual printing - only it knows what
   * paper is in the machine at the counter - and prints the copy number this
   * returns onto the document.
   *
   * Open to whoever may bill. A WAITER is excluded along with the rest of
   * billing: handing a customer a tax invoice is the cashier's station.
   */
  router.post('/invoices/:invoiceId/prints', requireRole(...CAN_BILL), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const print = await printService.recordInvoicePrint(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      pathParam(req, 'invoiceId'),
    );
    deps.logger.info(`invoice printed (copy ${String(print.copySequence)}) by ${staff.username}`);
    res.status(201).json({ print });
  });

  /**
   * Voids an unpaid invoice and reopens its order for correction.
   *
   * POST to an action, never DELETE on the document. The invoice row survives
   * with its number, its lines and its totals; what changes is that it now
   * says who withdrew it and why.
   */
  router.post('/invoices/:invoiceId/void', requireRole(...CAN_CORRECT), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const invoice = await billingService.voidInvoice(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      pathParam(req, 'invoiceId'),
      req.body,
    );

    // The floor is the reason this matters live: the table was AWAITING_PAYMENT
    // because an ACTIVE invoice outranked everything, and it now falls back to
    // whatever its kitchen state says.
    deps.realtime.orderUpdated({
      restaurantId: staff.restaurantId,
      orderId: invoice.orderId,
      tableId: null,
      deleted: false,
    });
    deps.logger.debug(`invoice:voided (#${String(invoice.invoiceNumber)})`);
    await auditFromRequest(
      deps.prisma,
      req,
      {
        action: 'INVOICE_VOIDED',
        summary: `Voided invoice #${String(invoice.invoiceNumber)}`,
        entityType: 'Invoice',
        entityId: pathParam(req, 'invoiceId'),
      },
      deps.logger,
    );
    res.json({ invoice });
  });

  /**
   * Reverses a payment while the bill is still open. See the service for why
   * this stops at the moment the sale closes.
   */
  router.post('/payments/:paymentId/void', requireRole(...CAN_CORRECT), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const invoice = await paymentsService.voidPayment(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      pathParam(req, 'paymentId'),
      req.body,
    );
    deps.realtime.orderUpdated({
      restaurantId: staff.restaurantId,
      orderId: invoice.orderId,
      tableId: null,
      deleted: false,
    });
    deps.logger.debug('payment:voided');
    await auditFromRequest(
      deps.prisma,
      req,
      {
        action: 'ORDER_VOIDED',
        summary: 'Voided a payment on an open bill',
        entityType: 'Payment',
        entityId: pathParam(req, 'paymentId'),
      },
      deps.logger,
    );
    res.json({ invoice });
  });

  return router;
}

function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Malformed request path.');
  }
  return value;
}

/**
 * Emitted after the service returns, i.e. after the write committed. The floor
 * listens to this too, because a table's colour is derived from the order on
 * it - creating a draft is what turns Table 4 OCCUPIED on every other screen.
 */
function announce(
  deps: OrdersRouterDeps,
  restaurantId: string,
  result: { readonly order: OrderResponse['order'] | null },
  what: string,
): void {
  if (result.order === null) return;
  deps.realtime.orderUpdated({
    restaurantId,
    orderId: result.order.id,
    tableId: result.order.table?.id ?? null,
    deleted: false,
  });
  deps.logger.debug(`order:updated (${what})`);
}

/**
 * Emitted after commit. `settled` is what the floor cares about: a partial
 * payment leaves the table AWAITING_PAYMENT, while the one that closes the
 * order frees it.
 */
function announceSettlement(
  deps: OrdersRouterDeps,
  restaurantId: string,
  invoice: { id: string; orderId: string; settlement: { remainingPaisa: number } },
): void {
  const settled = invoice.settlement.remainingPaisa === 0;
  deps.realtime.paymentRecorded({
    restaurantId,
    invoiceId: invoice.id,
    orderId: invoice.orderId,
    tableId: null,
    settled,
  });
  deps.realtime.orderUpdated({
    restaurantId,
    orderId: invoice.orderId,
    tableId: null,
    deleted: false,
  });
  deps.logger.debug(settled ? 'payment:recorded (settled)' : 'payment:recorded (partial)');
}
