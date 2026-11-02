import type { LoyaltySummary } from './loyalty';
import type { PromotionSummary } from './offers';
import type { StaffDuties } from './permissions';
import type { RefundDto } from './operations';

/**
 * Contracts shared by the local Nayaro RMS server and every client that talks
 * to it. The server produces these shapes; the renderer consumes them.
 *
 * They live here rather than in `packages/server` because a type that both
 * sides need, defined on one side, becomes two types the moment someone
 * copies it. Restaurant domain contracts (OrderStatus, PaymentMethod, and the
 * order/KOT/bill payloads) join this file from Phase 3.
 */

/** The JSON body of every error response the API produces. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

// --- GET /health -----------------------------------------------------------

export type HealthStatus = 'ok' | 'degraded';
export type DependencyStatus = 'connected' | 'error';
export type RealtimeStatus = 'ready' | 'error';

/**
 * Answers exactly one question: can this machine take orders right now?
 *
 * Nothing here may leak internal detail - no filesystem paths, no database
 * filename, no SQLite version, no configuration. It is the first thing a
 * support call will ask about, so it stays readable over the phone.
 */
export interface HealthResponse {
  readonly status: HealthStatus;
  readonly database: DependencyStatus;
  readonly realtime: RealtimeStatus;
  /** Whole seconds since the server started. Useful for spotting silent restarts. */
  readonly uptimeSeconds: number;
}

// --- authentication & first-run setup --------------------------------------

/**
 * Role presets. Staff can also receive extra order-taking or kitchen duties.
 *
 * Structurally identical to the Prisma `StaffRole` enum; the server asserts at
 * compile time that the two cannot drift (see auth.types.ts).
 *
 * WAITER is the order-taking role and nothing more: the floor, the menu, the
 * order and the kitchen board. It cannot bill, discount, take payment or
 * correct anything, which is what separates it from CASHIER.
 */
export type StaffRole = 'OWNER' | 'MANAGER' | 'CASHIER' | 'WAITER' | 'KITCHEN';

/** The only shape of a staff member that ever crosses the wire. */
export interface AuthenticatedStaff extends StaffDuties {
  readonly id: string;
  readonly restaurantId: string;
  readonly name: string;
  readonly username: string;
  readonly role: StaffRole;
}

export type TenantStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';

/** The restaurant (tenant) the signed-in staff member belongs to. */
export interface TenantSummary {
  readonly id: string;
  /** Workspace code typed at sign-in. */
  readonly workspace: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly plan: string;
  /** ISO instant, or null when the subscription does not lapse. */
  readonly subscriptionEndsAt: string | null;
}

export interface LoginRequest {
  /** Workspace code identifying the restaurant. */
  readonly workspace: string;
  readonly username: string;
  readonly password: string;
  readonly deviceLabel?: string;
}

export interface LoginResponse {
  /** Opaque bearer token, verified by the server on every request. */
  readonly token: string;
  readonly expiresAt: string;
  readonly staff: AuthenticatedStaff;
  readonly tenant: TenantSummary;
}

export interface MeResponse {
  readonly staff: AuthenticatedStaff;
  readonly tenant: TenantSummary;
}

export interface WorkspaceLookupResponse {
  readonly workspace: string;
  readonly name: string;
}

export interface RegisterTenantRequest {
  readonly restaurant: {
    readonly slug: string;
    readonly name: string;
    readonly address?: string;
    readonly phone?: string;
    readonly panNumber?: string;
    readonly contactEmail?: string;
  };
  readonly owner: {
    readonly name: string;
    readonly username: string;
    readonly password: string;
  };
  readonly settings?: {
    readonly vatEnabled?: boolean;
    readonly serviceChargeEnabled?: boolean;
  };
}

export interface RegisterTenantResponse {
  readonly restaurantId: string;
  readonly restaurantName: string;
  readonly workspace: string;
  readonly ownerStaffId: string;
  readonly ownerUsername: string;
}

export interface AuditLogEntry {
  readonly id: string;
  readonly action: string;
  readonly summary: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly ipAddress: string | null;
  readonly createdAt: string;
  readonly staff: { readonly name: string; readonly username: string; readonly role: StaffRole } | null;
}

export interface AuditLogResponse {
  readonly entries: readonly AuditLogEntry[];
  readonly hasMore: boolean;
}

// --- floor plan -------------------------------------------------------------

/**
 * What a table looks like to staff right now.
 *
 * DERIVED, never stored. The Phase 3 decision stands: `RestaurantTable` has no
 * status column, because a cached copy of something already true in the data
 * can drift, and the classic failure - payment succeeds, table update fails,
 * table occupied forever - becomes unrepresentable when there is nothing to
 * update.
 */
export type TableStatus = 'AVAILABLE' | 'OCCUPIED' | 'PREPARING' | 'READY' | 'AWAITING_PAYMENT';

export interface FloorTable {
  readonly id: string;
  readonly name: string;
  readonly capacity: number;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly status: TableStatus;
  /** Pin an open editor to this order even if it later moves tables. */
  readonly activeOrderId: string | null;
}

export interface FloorArea {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly tables: readonly FloorTable[];
}

export interface FloorResponse {
  readonly areas: readonly FloorArea[];
}

export interface CreateAreaRequest {
  readonly name: string;
  readonly sortOrder?: number;
}

export interface UpdateAreaRequest {
  readonly name?: string;
  readonly sortOrder?: number;
  readonly isActive?: boolean;
}

export interface CreateTableRequest {
  readonly areaId: string;
  readonly name: string;
  readonly capacity?: number;
  readonly sortOrder?: number;
}

export interface UpdateTableRequest {
  readonly areaId?: string;
  readonly name?: string;
  readonly capacity?: number;
  readonly sortOrder?: number;
  readonly isActive?: boolean;
}

// --- menu -------------------------------------------------------------------

export interface MenuItemSummary {
  readonly promotion?: PromotionSummary | null;
  readonly components?: readonly { readonly name: string; readonly quantity: number }[];
  readonly id: string;
  readonly name: string;
  readonly nameNp: string | null;
  readonly pricePaisa: number;
}

export interface MenuCategorySummary {
  readonly id: string;
  readonly name: string;
  readonly nameNp: string | null;
  readonly items: readonly MenuItemSummary[];
}

/**
 * The sellable menu, and only that. Retired items (isActive false) and
 * sold-out items (isAvailable false) never appear, so a cashier cannot tap
 * something the kitchen cannot make.
 */
export interface MenuResponse {
  readonly categories: readonly MenuCategorySummary[];
}

// --- orders -----------------------------------------------------------------

export type OrderStatus = 'DRAFT' | 'OPEN' | 'BILLED' | 'PAID' | 'VOID';
export type OrderType = 'DINE_IN' | 'TAKEAWAY';

export interface OrderItemDto {
  readonly promotion?: PromotionSummary | null;
  readonly components?: readonly { readonly name: string; readonly quantity: number }[];
  readonly id: string;
  readonly menuItemId: string;
  /** Snapshot taken when the item was added, not the menu's current name. */
  readonly name: string;
  readonly nameNp: string | null;
  readonly quantity: number;
  readonly unitPricePaisa: number;
  readonly note: string | null;
  readonly lineTotalPaisa: number;
  /**
   * How much of this line has already gone to the kitchen: the sum of its
   * KOTItem quantities across non-VOID tickets. Computed by the server so the
   * renderer never has to reconstruct KOT history to render a row.
   */
  readonly dispatchedQuantity: number;
  /** quantity - dispatchedQuantity. What the next Send would put on a ticket. */
  readonly undispatchedQuantity: number;
  /**
   * Dispatched units the customer cancelled. Never subtracted from `quantity`:
   * the line records what was ordered, and pretending otherwise would erase the
   * fact that the kitchen was told to cook it.
   */
  readonly cancelledQuantity: number;
  /** quantity - cancelledQuantity. What the bill will actually charge for. */
  readonly billableQuantity: number;
  /** Empty on almost every line. Present so the POS can show what was dropped. */
  readonly cancellations: readonly OrderItemCancellationDto[];
}

export interface OrderItemCancellationDto {
  readonly id: string;
  readonly quantity: number;
  readonly reason: string;
  readonly cancelledAt: string;
  readonly cancelledBy: { readonly id: string; readonly name: string };
}

export interface OrderTableRef {
  readonly id: string;
  readonly name: string;
}

export interface OrderDto {
  readonly id: string;
  readonly orderNumber: number;
  readonly status: OrderStatus;
  readonly type: OrderType;
  /** Null for takeaway. */
  readonly table: OrderTableRef | null;
  /**
   * Count of committed mutations. Every draft-editing request must send the
   * version it believes it is editing; the server refuses if they disagree.
   */
  readonly version: number;
  readonly items: readonly OrderItemDto[];
  /** sum(billableQuantity x unitPricePaisa). No tax, charge or discount here. */
  readonly subtotalPaisa: number;
  /** Live kitchen progress for this order. */
  readonly kitchen: OrderKitchenState;
  /**
   * Every ticket ever cut for this order, VOID ones included. The kitchen board
   * hides voided tickets because a cook must not act on them; the POS shows
   * them because a manager reviewing a correction needs to see that the
   * dispatch happened and was undone, by whom and why.
   */
  readonly tickets: readonly OrderTicketDto[];
  readonly tableTransfers: readonly OrderTableTransferDto[];
  /** Transfers stop once any invoice has been issued, including a later void. */
  readonly canTransferTable: boolean;
}

export interface TransferTableRequest {
  readonly expectedVersion: number;
  readonly toTableId: string;
}

export interface OrderTableTransferDto {
  readonly id: string;
  readonly from: OrderTableRef;
  readonly to: OrderTableRef;
  readonly at: string;
  readonly staff: { readonly id: string; readonly name: string };
}

export interface OrderTicketDto {
  readonly id: string;
  readonly kotNumber: number;
  readonly status: KotStatus;
  readonly createdAt: string;
  readonly items: readonly { readonly name: string; readonly quantity: number }[];
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly voidedBy: { readonly id: string; readonly name: string } | null;
}

/**
 * What the kitchen is doing with this order, in four numbers.
 *
 * Enough for the POS to say "1 preparing, 1 ready" without shipping every
 * ticket to it or making the renderer reconstruct KOT history. VOID tickets
 * are excluded, so the counts describe live work only.
 */
export interface OrderKitchenState {
  readonly ticketCount: number;
  readonly newCount: number;
  readonly preparingCount: number;
  readonly readyCount: number;
  readonly servedCount: number;
}

export interface OrderResponse {
  readonly order: OrderDto;
}

/**
 * Used where "there is no order" is a normal answer rather than an error: an
 * empty table, or an order that was just deleted by removing its last item.
 */
/** Open takeaway orders, for the strip on the floor screen. */
export interface MaybeOrderListResponse {
  readonly orders: readonly OrderDto[];
}

export interface MaybeOrderResponse {
  readonly order: OrderDto | null;
}

/**
 * What an add-item request is aiming at.
 *
 * TABLE and TAKEAWAY mean "no order exists yet, create one with this item".
 * ORDER means "add to this order", and carries the version being edited.
 * Modelled as a discriminated union so an impossible combination - an orderId
 * with no version, a tableId and an orderId together - cannot be expressed.
 */
export type AddOrderItemTarget =
  | { readonly kind: 'TABLE'; readonly tableId: string }
  | { readonly kind: 'TAKEAWAY' }
  | { readonly kind: 'ORDER'; readonly orderId: string; readonly expectedVersion: number };

export interface AddOrderItemRequest {
  readonly target: AddOrderItemTarget;
  readonly menuItemId: string;
  /** Defaults to 1 - one tap, one plate. */
  readonly quantity?: number;
  readonly note?: string;
}

export interface UpdateOrderItemRequest {
  readonly expectedVersion: number;
  /** Must stay at least 1. To reach zero, remove the item. */
  readonly quantity?: number;
  /** Null clears the note. */
  readonly note?: string | null;
}

// --- kitchen ----------------------------------------------------------------

export type KotStatus = 'NEW' | 'PREPARING' | 'READY' | 'SERVED' | 'VOID';

export interface KitchenTicketItem {
  readonly id: string;
  readonly name: string;
  readonly nameNp: string | null;
  readonly quantity: number;
  /** What this ticket told the kitchen, frozen at dispatch. */
  readonly note: string | null;
}

/**
 * A dispatched batch, as the kitchen sees it.
 *
 * Everything on it is a snapshot taken when the ticket was cut. A dish renamed
 * or a note edited afterwards does not rewrite what the kitchen was told to
 * cook - which is the whole reason KOTItem carries its own copies.
 */
export interface KitchenTicket {
  readonly id: string;
  readonly kotNumber: number;
  readonly orderId: string;
  readonly orderNumber: number;
  readonly orderType: OrderType;
  /** Null for takeaway; the renderer labels those "Takeaway". */
  readonly tableName: string | null;
  readonly status: KotStatus;
  /** ISO timestamp. The renderer's timer counts from here, and never resets. */
  readonly createdAt: string;
  /**
   * When each transition actually happened, ISO, or null if not reached yet.
   * Written once and never rewritten - a duplicate click cannot move them.
   * The elapsed timer ignores these entirely: it measures how long food has
   * been waiting since it was ordered, not since it last changed column.
   */
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly servedAt: string | null;
  /** The server's own answer at response time. The renderer ticks on from it. */
  readonly elapsedSeconds: number;
  readonly items: readonly KitchenTicketItem[];
}

export interface KitchenTicketsResponse {
  readonly newTicketAlertMinutes: number;
  readonly tickets: readonly KitchenTicket[];
}

/**
 * The states a ticket can be moved TO. VOID is absent on purpose: voiding a
 * mis-sent ticket returns its quantities to undispatched and is a deliberate
 * manager action, not a step in the cooking workflow.
 */
export type KotTransitionTarget = 'PREPARING' | 'READY' | 'SERVED';

export interface TransitionKotRequest {
  readonly status: KotTransitionTarget;
}

export interface SendToKitchenRequest {
  readonly expectedVersion: number;
}

export interface SendToKitchenResponse {
  readonly order: OrderDto;
  /** The ticket just cut, so the POS can confirm exactly what went. */
  readonly kot: KitchenTicket;
}

// --- billing -----------------------------------------------------------------

export type DiscountType = 'NONE' | 'PERCENT' | 'FIXED';
export type InvoiceType = 'STANDARD' | 'ABBREVIATED';
export type InvoiceStatus = 'ACTIVE' | 'VOID';

/**
 * A line as it will be billed.
 *
 * `billableQuantity` is what the money is calculated from - ordered minus
 * anything cancelled. The other two are shown so a cashier can see WHY a line
 * bills for less than was ordered.
 */
export interface PreBillLine {
  readonly promotion?: PromotionSummary | null;
  readonly orderItemId: string;
  readonly name: string;
  readonly nameNp: string | null;
  readonly quantity: number;
  readonly cancelledQuantity: number;
  readonly billableQuantity: number;
  readonly unitPricePaisa: number;
  readonly lineTotalPaisa: number;
}

export interface PreBillDiscount {
  readonly type: DiscountType;
  /** Basis points for PERCENT, paisa for FIXED, 0 for NONE. */
  readonly value: number;
  readonly amountPaisa: number;
}

/** A charge and the rate actually used. A disabled charge reports rate 0. */
export interface PreBillCharge {
  readonly enabled: boolean;
  readonly rateBp: number;
  readonly amountPaisa: number;
}

/**
 * A live calculation over the order's CURRENT state.
 *
 * NOT a tax invoice: it has no number, nothing is persisted by reading it, and
 * it changes as the order changes. Everything here is recomputed on every read.
 */
export interface PreBillDto {
  readonly loyalty?: LoyaltySummary | null;
  readonly orderId: string;
  readonly orderNumber: number;
  readonly orderType: OrderType;
  readonly tableName: string | null;
  /** The version a discount or issue request must send back. */
  readonly orderVersion: number;

  readonly lines: readonly PreBillLine[];
  readonly subtotalPaisa: number;
  readonly discount: PreBillDiscount;
  readonly serviceCharge: PreBillCharge;
  readonly vat: PreBillCharge;
  readonly roundingAdjustmentPaisa: number;
  readonly grandTotalPaisa: number;

  /** Set when tickets are still with the kitchen. Advisory: billing is allowed. */
  readonly kitchenWarning: string | null;
  /** Whether ABBREVIATED may be chosen for this bill, and why not if it cannot. */
  readonly abbreviated: {
    readonly authorized: boolean;
    readonly ceilingPaisa: number;
    readonly available: boolean;
    readonly unavailableReason: string | null;
  };
}

export interface InvoiceLineDto {
  readonly promotion?: PromotionSummary | null;
  readonly id: string;
  readonly lineNumber: number;
  readonly description: string;
  readonly descriptionNp: string | null;
  readonly quantity: number;
  readonly unitPricePaisa: number;
  readonly lineTotalPaisa: number;
}

export interface InvoiceBuyer {
  readonly name: string | null;
  readonly pan: string | null;
  readonly address: string | null;
}

/**
 * An issued invoice, frozen.
 *
 * Everything needed to render the document is here. Reproducing it must never
 * require the current MenuItem, OrderItem or RestaurantSettings - those all
 * change, and an issued invoice does not.
 */
export interface InvoiceDto {
  readonly loyalty?: LoyaltySummary | null;
  readonly id: string;
  readonly invoiceType: InvoiceType;
  readonly invoiceNumber: number;
  readonly fiscalYearStartBsYear: number;
  /** "2082/83". Display form, computed at read time, never persisted. */
  readonly fiscalYearLabel: string;
  readonly status: InvoiceStatus;
  readonly issuedAt: string;
  readonly businessDate: string;

  readonly orderId: string;
  readonly orderNumber: number;
  readonly orderType: OrderType;
  readonly tableName: string | null;
  /** The order's CURRENT version, for the settlement request. Not frozen. */
  readonly orderVersion: number;

  /**
   * Who issued it, as recorded at the time. Null on invoices issued before
   * Phase 4H, which stored no seller and cannot honestly invent one.
   */
  readonly seller: {
    readonly name: string | null;
    readonly address: string | null;
    readonly pan: string | null;
  };
  readonly buyer: InvoiceBuyer;
  readonly lines: readonly InvoiceLineDto[];

  readonly subtotalPaisa: number;
  readonly discount: PreBillDiscount;
  readonly serviceCharge: PreBillCharge;
  readonly vat: PreBillCharge;
  readonly roundingAdjustmentPaisa: number;
  readonly grandTotalPaisa: number;

  /**
   * Payment progress. Derived at read time and NOT part of the frozen
   * document - the figures above never change, this one does as money arrives.
   */
  readonly settlement: SettlementDto;

  /**
   * How many times this bill has been put on paper.
   *
   * Zero until it is first printed. The first print is the document; every
   * later one is a copy and is marked as such on its face, so a customer
   * cannot end up holding two things that both look like the original.
   */
  readonly printCount: number;

  /**
   * Set only when `status` is VOID. The number stays consumed forever and the
   * document stays readable; this says who withdrew it and why.
   */
  readonly void: {
    readonly voidedAt: string;
    readonly reason: string;
    readonly voidedBy: { readonly id: string; readonly name: string };
  } | null;
}

// --- printing ----------------------------------------------------------------

/**
 * What the server records when a bill is sent to a printer.
 *
 * Note what it is NOT: confirmation that paper came out. The server cannot
 * know that - the printer belongs to the machine at the counter - so this is
 * the recorded INTENT plus the copy number the renderer must print on the
 * document. An empty roll leaves a row here and nothing in the customer's
 * hand, which is the honest outcome and why `printCount` counts attempts.
 */
export interface InvoicePrintReceipt {
  readonly invoiceId: string;
  /** 1 is the original. 2 and up must be rendered with a copy mark. */
  readonly copySequence: number;
  readonly printCount: number;
  readonly isReprint: boolean;
  readonly printedAt: string;
  readonly printedBy: { readonly id: string; readonly name: string };
}

export interface RecordInvoicePrintResponse {
  readonly print: InvoicePrintReceipt;
}

/**
 * The paper a bill is printed on.
 *
 * A property of the PRINTER attached to one machine, not of the restaurant -
 * which is why it is chosen at the till and never stored in RestaurantSettings.
 * A counter with an 80mm thermal printer and a back office with an A4 laser
 * are the same restaurant and must not fight over one setting.
 *
 * The two thermal widths are the ones sold in Nepal; A4 exists because a
 * customer occasionally wants a proper tax invoice for their own books.
 */
export type BillPaperSize = 'THERMAL_58' | 'THERMAL_80' | 'A4';

export interface BillPaperSpec {
  readonly id: BillPaperSize;
  readonly label: string;
  readonly hint: string;
  /** CSS width of the printable area, including the unit. */
  readonly widthCss: string;
  /** What goes in `@page { size: ... }`. */
  readonly pageSize: string;
  /** Roll printers cut to length; sheet printers do not. */
  readonly continuous: boolean;
}

/**
 * The catalogue, shared so the print dialog and the document it renders can
 * never disagree about how wide 80mm is.
 *
 * The printable widths are narrower than the paper: a 58mm roll prints about
 * 48mm and an 80mm roll about 72mm, because the head does not reach the edge.
 * Using the paper width here is the classic mistake that clips the last
 * character off every line.
 */
export const BILL_PAPER_SPECS: readonly BillPaperSpec[] = [
  {
    id: 'THERMAL_80',
    label: '80mm roll',
    hint: 'The common thermal till printer.',
    widthCss: '72mm',
    pageSize: '80mm auto',
    continuous: true,
  },
  {
    id: 'THERMAL_58',
    label: '58mm roll',
    hint: 'The narrow thermal roll, often on portable printers.',
    widthCss: '48mm',
    pageSize: '58mm auto',
    continuous: true,
  },
  {
    id: 'A4',
    label: 'A4 sheet',
    hint: 'An ordinary printer, for a customer who wants a full tax invoice.',
    widthCss: '180mm',
    pageSize: 'A4 portrait',
    continuous: false,
  },
];

/**
 * Exactly one of the first two is non-null. The server decides which: an order
 * with an ACTIVE invoice shows the issued document, never a fresh pre-bill.
 */
export interface BillingResponse {
  readonly preBill: PreBillDto | null;
  readonly invoice: InvoiceDto | null;
  /**
   * Bills that were issued for this order and then withdrawn, oldest first.
   *
   * Usually empty. A voided invoice never comes back as `invoice` - that field
   * is the live document - so without this the correction would be invisible
   * the moment it succeeded, and "why does this order have no bill when I
   * printed one?" would have no answer on any screen.
   */
  readonly voidedInvoices: readonly VoidedInvoiceDto[];
}

/** Enough of a withdrawn bill to explain it. The document itself is unchanged. */
export interface VoidedInvoiceDto {
  readonly id: string;
  readonly invoiceNumber: number;
  readonly fiscalYearLabel: string;
  readonly grandTotalPaisa: number;
  readonly issuedAt: string;
  readonly voidedAt: string;
  readonly reason: string;
  readonly voidedBy: { readonly id: string; readonly name: string };
}

// --- invoice history ---------------------------------------------------------

/**
 * One row of the bills list. Enough to find a document and open it - the
 * document itself is fetched through the order's billing read, which already
 * knows how to reprint, settle and void it.
 */
export interface InvoiceSummaryDto {
  readonly refundedPaisa: number;
  readonly id: string;
  readonly invoiceType: InvoiceType;
  readonly invoiceNumber: number;
  readonly fiscalYearLabel: string;
  readonly status: InvoiceStatus;
  readonly issuedAt: string;
  readonly businessDate: string;
  readonly issuedBy: { readonly id: string; readonly name: string };
  readonly orderId: string;
  readonly orderNumber: number;
  readonly orderType: OrderType;
  readonly tableName: string | null;
  readonly buyerName: string | null;
  readonly buyerPan: string | null;
  readonly grandTotalPaisa: number;
  /** Live payments only; a reversed payment is history, not money. */
  readonly totalPaidPaisa: number;
  readonly settlementStatus: PaymentStatus;
  /** Distinct methods of the live payments, in the order they were taken. */
  readonly paymentMethods: readonly PaymentMethod[];
  readonly printCount: number;
}

export interface InvoiceListTotals {
  readonly refundedPaisa: number;
  readonly activeCount: number;
  readonly voidCount: number;
  /** ACTIVE invoices only. A voided bill was never owed. */
  readonly billedPaisa: number;
  readonly paidPaisa: number;
  readonly outstandingPaisa: number;
}

export type InvoiceListStatusFilter = 'ALL' | 'ACTIVE' | 'VOID';

export interface InvoiceListResponse {
  /** The inclusive business-date range that was searched, "YYYY-MM-DD". */
  readonly from: string;
  readonly to: string;
  /** Newest first. */
  readonly invoices: readonly InvoiceSummaryDto[];
  /** Over every match, not just the rows returned. */
  readonly totals: InvoiceListTotals;
  /** True when more rows matched than were returned. Narrow the search. */
  readonly truncated: boolean;
}

export interface SetDiscountRequest {
  readonly expectedVersion: number;
  readonly discountType: DiscountType;
  /** Basis points for PERCENT, paisa for FIXED. Ignored for NONE. */
  readonly discountValue?: number;
}

export interface IssueInvoiceRequest {
  readonly expectedVersion: number;
  /** Defaults to STANDARD. Never selected automatically from the amount. */
  readonly invoiceType?: InvoiceType;
  readonly buyerName?: string;
  readonly buyerPan?: string;
  readonly buyerAddress?: string;
}

export interface IssueInvoiceResponse {
  readonly invoice: InvoiceDto;
}

// --- payments ----------------------------------------------------------------

export type PaymentMethod = 'CASH' | 'QR' | 'CARD' | 'CREDIT';

/**
 * Derived from the payments against an invoice - never a stored column.
 *
 * PAID here means "settled", which includes a bill closed to CREDIT: the guest
 * has left, the restaurant carries the receivable, and the table is free. It is
 * NOT the same as "cash in the drawer", and reports will need to tell them
 * apart.
 */
export type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';

export interface PaymentDto {
  readonly id: string;
  readonly method: PaymentMethod;
  /** What was applied to the bill. For cash this is not what was handed over. */
  readonly amountPaisa: number;
  readonly itemAllocations: readonly PaymentItemAllocationDto[];
  readonly refunds: readonly RefundDto[];
  /** Cash handed over, when it differed from the amount applied. */
  readonly tenderedPaisa: number | null;
  /** tendered - amount. Derived, never stored. */
  readonly changePaisa: number;
  readonly reference: string | null;
  readonly creditAccountName: string | null;
  readonly customerId?: string | null;
  readonly createdAt: string;
  readonly receivedBy: { readonly id: string; readonly name: string };
  /**
   * Set only on a reversed payment. A voided row still appears on the bill -
   * hiding it would make the cash drawer disagree with the screen and leave
   * nobody able to explain the difference - but it counts for nothing.
   */
  readonly void: {
    readonly voidedAt: string;
    readonly reason: string;
    readonly voidedBy: { readonly id: string; readonly name: string };
  } | null;
}

/**
 * How much of an issued invoice has been settled.
 *
 * Everything here is computed from Payment rows at read time. There is
 * deliberately no `amountPaid` column: a stored counter is a second copy of a
 * fact that can drift from the payments it summarises, and reconciling a till
 * against its own software is not a job anyone should have.
 */
export interface SettlementDto {
  readonly payments: readonly PaymentDto[];
  readonly totalPaidPaisa: number;
  readonly remainingPaisa: number;
  readonly status: PaymentStatus;
}

export interface RecordPaymentRequest {
  /**
   * The order version the client believes it is settling. Payments serialise
   * through it, so two terminals cannot both settle the same balance.
   */
  readonly expectedOrderVersion: number;
  readonly method: PaymentMethod;
  /** Applied to the bill. Must never exceed what remains. */
  readonly amountPaisa: number;
  /** Optional item selection. The server verifies its exact share of the total. */
  readonly items?: readonly PaymentItemSelection[];
  /** CASH only: what the customer handed over, if more than the amount. */
  readonly tenderedPaisa?: number;
  /** QR or card transaction identifier. */
  readonly reference?: string;
  /** CREDIT only: an active customer account is required. */
  readonly customerId?: string;
  /** Legacy display field. The server snapshots the selected customer name. */
  readonly creditAccountName?: string;
}

export interface PaymentItemSelection {
  readonly invoiceLineId: string;
  readonly quantity: number;
}

export interface PaymentItemAllocationDto extends PaymentItemSelection {
  readonly amountPaisa: number;
}

export interface SettleInvoiceRequest {
  readonly expectedOrderVersion: number;
}

// --- Corrections -----------------------------------------------------------

/**
 * Every correction carries a reason, and the server requires it to be real
 * text. A correction without one is indistinguishable from a mistake six
 * months later, which is precisely when someone asks about it.
 *
 * None of these carry an expected version. The server reads the state it is
 * correcting inside the same transaction that writes the correction and
 * compare-and-swaps on it, so a stale client cannot cause a wrong result - only
 * a refused one.
 */
export interface CorrectionRequest {
  readonly reason: string;
}

export interface CancelOrderItemRequest extends CorrectionRequest {
  /** How many of the dispatched units the customer no longer wants. */
  readonly quantity: number;
}

// --- realtime ---------------------------------------------------------------

/**
 * Socket.IO event names. Shared so the emitter and the listener cannot drift.
 *
 * Events carry a minimal payload and act as invalidation signals, not as a
 * second copy of server state - the client refetches through TanStack Query
 * rather than patching a local cache from the wire.
 */
export const REALTIME_EVENTS = {
  /** Floor CONFIGURATION changed: an area or table was added or edited. */
  floorUpdated: 'floor:updated',
  /**
   * An order was created, edited or deleted. Also invalidates the floor,
   * because a table's status is derived from the order sitting on it.
   */
  orderUpdated: 'order:updated',
  /** A batch was dispatched to the kitchen. */
  kotCreated: 'kot:created',
  /** A ticket moved along the kitchen workflow. */
  kotUpdated: 'kot:updated',
  /** An invoice was issued for an order. */
  invoiceIssued: 'invoice:issued',
  /** Money was recorded against an invoice, or a zero-total bill was settled. */
  paymentRecorded: 'payment:recorded',
  /**
   * The catalogue changed. The only management event that needs to travel:
   * a till holding a cached menu would otherwise keep selling a dish the
   * kitchen has just run out of.
   */
  menuUpdated: 'menu:updated',
} as const;

export interface FloorUpdatedPayload {
  readonly restaurantId: string;
}

export interface KotCreatedPayload {
  readonly restaurantId: string;
  readonly kotId: string;
  readonly kotNumber: number;
  readonly orderId: string;
  readonly tableId: string | null;
}

export interface KotUpdatedPayload {
  readonly restaurantId: string;
  readonly kotId: string;
  readonly orderId: string;
  /** Null for takeaway. */
  readonly tableId: string | null;
  readonly status: KotStatus;
}

export interface InvoiceIssuedPayload {
  readonly restaurantId: string;
  readonly invoiceId: string;
  readonly orderId: string;
  /** Null for takeaway. */
  readonly tableId: string | null;
}

export interface MenuUpdatedPayload {
  readonly restaurantId: string;
}

export interface PaymentRecordedPayload {
  readonly restaurantId: string;
  readonly invoiceId: string;
  readonly orderId: string;
  /** Null for takeaway. */
  readonly tableId: string | null;
  /** True when this payment closed the order and freed the table. */
  readonly settled: boolean;
}

export interface OrderUpdatedPayload {
  readonly restaurantId: string;
  readonly orderId: string;
  /** Null for takeaway. Lets a table-scoped screen tell if it is affected. */
  readonly tableId: string | null;
  /** True when the order was removed because its last item was taken off. */
  readonly deleted: boolean;
}
