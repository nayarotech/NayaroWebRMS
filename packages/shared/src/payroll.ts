export interface PayrollStaffDto {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly monthlySalaryPaisa: number | null;
  readonly profileVersion: number | null;
}
export interface PayrollRecordDto {
  readonly id: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly month: string;
  readonly status: 'DRAFT' | 'APPROVED';
  readonly version: number;
  readonly baseSalaryPaisa: number;
  readonly allowancesPaisa: number;
  readonly deductionsPaisa: number;
  readonly netSalaryPaisa: number;
  readonly paidPaisa: number;
  readonly advancePaisa: number;
  readonly remainingPaisa: number;
  readonly settled: boolean;
  readonly note: string;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly canReopen: boolean;
  readonly payments: readonly {
    readonly id: string;
    readonly kind: 'ADVANCE' | 'SALARY';
    readonly amountPaisa: number;
    readonly method: 'CASH' | 'QR' | 'CARD';
    readonly reference: string | null;
    readonly note: string;
    readonly businessDate: string;
    readonly at: string;
    readonly paidBy: string;
    readonly expenseId: string;
    readonly cashMovementId: string | null;
  }[];
  readonly audits: readonly {
    readonly id: string;
    readonly kind: string;
    readonly at: string;
    readonly actor: string;
    readonly note: string;
    readonly beforeJson: string | null;
    readonly afterJson: string;
  }[];
}
export interface PayrollOverview {
  readonly month: string;
  readonly currentBusinessDate: string;
  readonly staff: readonly PayrollStaffDto[];
  readonly records: readonly PayrollRecordDto[];
  readonly totals: {
    readonly approvedNetPaisa: number;
    readonly paidPaisa: number;
    readonly advancesPaisa: number;
    readonly approvedRemainingPaisa: number;
  };
}
