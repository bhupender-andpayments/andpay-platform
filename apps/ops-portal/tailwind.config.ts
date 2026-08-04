import type { Config } from 'tailwindcss'

// Demo skin token bridge: semantic Tailwind color/radius/shadow/font names
// mapped onto the CSS custom properties defined in src/index.css. Components
// use semantic classes (bg-surface, text-muted, border-line, bg-brand) so the
// whole skin recolors from one token file.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-3': 'var(--surface-3)',
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        ink: 'var(--text)',
        muted: 'var(--text-muted)',
        subtle: 'var(--text-subtle)',
        brand: 'var(--brand)',
        'brand-strong': 'var(--brand-strong)',
        'brand-weak': 'var(--brand-weak)',
        'brand-contrast': 'var(--brand-contrast)',
        accent: 'var(--accent)',
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'var(--radius-sm)',
        lg: 'var(--radius-lg)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        lg: 'var(--shadow-lg)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
    },
  },
  plugins: [],
} satisfies Config
