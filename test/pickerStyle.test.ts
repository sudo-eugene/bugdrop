import { describe, expect, it } from 'vitest';
import { resolvePickerStyle } from '../src/widget/picker';
import { DEFAULT_ACCENT_COLOR } from '../src/defaults';

describe('resolvePickerStyle', () => {
  it('passes through valid style values', () => {
    expect(
      resolvePickerStyle({
        accentColor: '#2563eb',
        font: 'Inter, system-ui, sans-serif',
        radius: '8',
        borderWidth: '2',
        bgColor: '#ffffff',
        textColor: '#111827',
        borderColor: '#d1d5db',
      })
    ).toEqual({
      accent: '#2563eb',
      fontFamily: 'Inter, system-ui, sans-serif',
      radius: '8px',
      bw: '2',
      tooltipBg: '#ffffff',
      tooltipText: '#111827',
      tooltipBorder: '#d1d5db',
    });
  });

  it('falls back when style values contain CSS-breaking tokens', () => {
    expect(
      resolvePickerStyle({
        accentColor: 'red; } .hostile { color: red }',
        font: 'Inter; color: red',
        radius: '8em',
        borderWidth: '-1',
        bgColor: 'url(https://example.com/x)',
        textColor: '</style><script>alert(1)</script>',
        borderColor: '#000; color: red',
      })
    ).toEqual({
      accent: DEFAULT_ACCENT_COLOR,
      fontFamily: "'Space Grotesk', system-ui, sans-serif",
      radius: '6px',
      bw: '3',
      tooltipBg: '#1a1a1a',
      tooltipText: '#f1f5f9',
      tooltipBorder: '#333',
    });
  });
});
