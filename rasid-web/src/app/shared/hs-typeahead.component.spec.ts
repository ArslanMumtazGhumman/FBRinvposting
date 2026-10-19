import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HsOption, ReferenceService } from '../core/reference.service';
import { HsTypeaheadComponent } from './hs-typeahead.component';

const SUGAR: HsOption[] = [{ code: '1701.1400', desc: 'Cane sugar, raw' }, { code: '1701.9910', desc: 'Refined sugar' }];

@Component({
  imports: [HsTypeaheadComponent],
  template: `<app-hs-typeahead [value]="value()" ariaLabel="HS code" (valueChange)="value.set($event)" (picked)="picked.push($event)" />`,
})
class HostComponent {
  value = signal('');
  picked: HsOption[] = [];
}

describe('HsTypeaheadComponent', () => {
  let search: ReturnType<typeof vi.fn>;
  let host: HostComponent;
  let input: HTMLInputElement;
  let render: () => Promise<void>;

  beforeEach(async () => {
    vi.useFakeTimers();
    search = vi.fn(async (q: string) => (q.startsWith('sug') ? SUGAR : []));
    TestBed.configureTestingModule({ providers: [{ provide: ReferenceService, useValue: { searchHs: search } }] });
    const fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    render = async () => { await vi.runAllTimersAsync(); fixture.detectChanges(); await fixture.whenStable(); };
    await render();
    input = fixture.nativeElement.querySelector('input');
  });
  afterEach(() => { vi.useRealTimers(); document.querySelectorAll('.cdk-overlay-container').forEach(e => e.remove()); });

  const type = (text: string) => { input.value = text; input.dispatchEvent(new Event('input')); };
  const key = (k: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const options = () => [...document.querySelectorAll('.hs-pop li')].map(li => li.textContent!.replace(/\s+/g, ' ').trim());

  it('searches 200 ms after the last keystroke and lists "code · description"', async () => {
    type('s'); type('su'); type('sug');
    expect(host.value()).toBe('sug');
    await vi.advanceTimersByTimeAsync(199);
    expect(search).not.toHaveBeenCalled();
    await render();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('sug', 20);
    expect(options()).toEqual(['1701.1400 · Cane sugar, raw', '1701.9910 · Refined sugar']);
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('↓ and Enter pick an option; the input shows its code', async () => {
    type('sugar');
    await render();
    key('ArrowDown');
    await render();
    expect(input.getAttribute('aria-activedescendant')).toMatch(/-1$/);
    key('Enter');
    await render();
    expect(host.picked).toEqual([SUGAR[1]]);
    expect(input.value).toBe('1701.9910');
    expect(options()).toEqual([]);
  });

  it('Escape closes; a complete code or one character does not search', async () => {
    type('sugar');
    await render();
    key('Escape');
    await render();
    expect(options()).toEqual([]);
    search.mockClear();
    type('1701.9910'); type('s');
    await render();
    expect(search).not.toHaveBeenCalled();
  });
});
