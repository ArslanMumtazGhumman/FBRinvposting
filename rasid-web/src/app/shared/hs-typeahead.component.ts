import { CdkConnectedOverlay, CdkOverlayOrigin, ConnectedPosition } from '@angular/cdk/overlay';
import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, inject, input, output, signal, viewChild } from '@angular/core';
import { HsOption, ReferenceService } from '../core/reference.service';

let nextId = 0;

/**
 * HS code input with suggestions from FBR's HS list ("code · description").
 * Searches 200 ms after the last keystroke; ↑/↓ move, Enter picks, Esc closes.
 * Emits every typed value (valueChange) and the option picked (picked).
 */
@Component({
  selector: 'app-hs-typeahead',
  imports: [CdkOverlayOrigin, CdkConnectedOverlay],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <input #box cdkOverlayOrigin #origin="cdkOverlayOrigin" [class]="inputClass()" [class.invalid]="invalid()" [value]="value()"
           [attr.id]="inputId() || null" [attr.title]="title() || null" [attr.aria-label]="ariaLabel() || null" [placeholder]="placeholder()"
           autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" [attr.aria-expanded]="open()" [attr.aria-controls]="listId"
           [attr.aria-activedescendant]="open() && active() >= 0 ? listId + '-' + active() : null"
           (input)="onInput($any($event.target).value)" (keydown)="onKey($event)" (blur)="close()" />
    <ng-template cdkConnectedOverlay [cdkConnectedOverlayOrigin]="origin" [cdkConnectedOverlayOpen]="open()" [cdkConnectedOverlayPositions]="positions"
                 [cdkConnectedOverlayMinWidth]="minWidth()" (overlayOutsideClick)="close()" (detach)="close()">
      <ul class="hs-pop" role="listbox" [id]="listId" aria-label="HS codes">
        @for (h of options(); track h.code; let k = $index) {
          <li role="option" [id]="listId + '-' + k" [attr.aria-selected]="k === active()" [class.on]="k === active()"
              (mousedown)="$event.preventDefault(); pick(h)" (mouseenter)="active.set(k)">
            <b>{{ h.code }}</b> · <span>{{ h.desc }}</span>
          </li>
        }
      </ul>
    </ng-template>`,
  styles: [`
    :host { display: block; }
    input { width: 100%; }
    .hs-pop { list-style: none; margin: 4px 0; padding: 4px; background: var(--surface); border: 1px solid var(--line-strong);
      border-radius: var(--radius-s); box-shadow: var(--shadow-pop); max-height: 280px; overflow: auto; max-width: min(560px, 92vw); }
    .hs-pop li { padding: 7px 10px; border-radius: 4px; cursor: pointer; font-size: var(--fs-s); line-height: 1.35; }
    .hs-pop li b { font-variant-numeric: tabular-nums; }
    .hs-pop li span { color: var(--ink-2); }
    .hs-pop li.on { background: var(--accent-soft); }
  `],
})
export class HsTypeaheadComponent implements OnDestroy {
  private ref = inject(ReferenceService);

  readonly value = input('');
  readonly invalid = input(false);
  readonly inputClass = input('input');
  readonly inputId = input('');
  readonly placeholder = input('0000.0000 or words');
  readonly ariaLabel = input('');
  readonly title = input('');
  readonly valueChange = output<string>();
  readonly picked = output<HsOption>();

  protected readonly listId = `hs-list-${nextId++}`;
  protected options = signal<HsOption[]>([]);
  protected open = signal(false);
  protected active = signal(-1);
  private box = viewChild.required<ElementRef<HTMLInputElement>>('box');
  private timer?: ReturnType<typeof setTimeout>;
  private typed = '';
  protected readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top' },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
  ];
  protected minWidth = () => Math.max(this.box().nativeElement.offsetWidth, 320);

  protected onInput(text: string) {
    this.typed = text;
    this.valueChange.emit(text);
    clearTimeout(this.timer);
    const q = text.trim();
    // A complete code needs no suggestions.
    if (q.length < 2 || /^\d{4}\.\d{4}$/.test(q)) { this.close(); return; }
    this.timer = setTimeout(async () => {
      const found = await this.ref.searchHs(q, 20);
      if (this.typed.trim() !== q) return; // typed on meanwhile
      this.options.set(found);
      this.active.set(found.length ? 0 : -1);
      this.open.set(found.length > 0);
    }, 200);
  }

  protected onKey(e: KeyboardEvent) {
    const n = this.options().length;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (!n) return;
        e.preventDefault();
        if (!this.open()) { this.open.set(true); return; }
        this.active.update(k => (k + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
        this.scrollActive();
        return;
      case 'Enter':
        if (this.open() && this.active() >= 0) { e.preventDefault(); e.stopPropagation(); this.pick(this.options()[this.active()]!); }
        return;
      case 'Escape':
        if (this.open()) { e.preventDefault(); this.close(); }
        return;
      case 'Tab':
        this.close();
        return;
    }
  }

  protected pick(h: HsOption) {
    clearTimeout(this.timer);
    this.typed = h.code;
    this.box().nativeElement.value = h.code;
    this.close();
    this.picked.emit(h);
  }

  protected close() { this.open.set(false); }

  private scrollActive() {
    queueMicrotask(() => document.getElementById(`${this.listId}-${this.active()}`)?.scrollIntoView?.({ block: 'nearest' }));
  }

  ngOnDestroy() { clearTimeout(this.timer); }
}
