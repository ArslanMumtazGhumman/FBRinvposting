import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { InvoiceStatus } from '../core/models';

const LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft', validated: 'Validated', queued: 'Queued', posting: 'Posting', posted: 'Posted', failed: 'Rejected',
};

@Component({
  selector: 'app-status-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="chip" [class]="status()">{{ label() }}</span>`,
})
export class StatusChipComponent {
  readonly status = input.required<InvoiceStatus>();
  protected label = computed(() => LABELS[this.status()]);
}
