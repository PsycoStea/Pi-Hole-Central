# Pi-hole Central — design
stage: done

## Brief
- Who / how often: one homelab admin (plus optional viewers), daily glance + occasional admin work. Low motion budget.
- Personality: "normal looking modern": clean, calm, neutral surfaces, one blue accent. No glass, glow or gradient text.
- Platform: web; desktop first, must work on a phone (390 px).
- Constraints: light + dark (next-themes toggle stays), WCAG AA text contrast, shadcn (base-nova) components and CSS variables stay the mechanism.

## Scope
1. App shell: sidebar (desktop), top bar + drawer (phone/tablet), consistent content width and padding.
2. Overview (home): header + actions, stat row, chart, top lists, instance cards.
3. Page header pattern applied to every page; other pages pick up tokens without layout rework.

## Direction
Skipped the directions round at the user's request ("no need for mockups, just build").
Neutral cool-grey canvas, white/near-black cards with 1px borders and a soft shadow in light mode, blue primary, semantic success/warning/destructive tokens, Geist Sans for everything.

## Tokens
- Mechanism: CSS variables in src/app/globals.css (shadcn), mapped in `@theme inline`.
- Colour roles per theme: background, card, popover, primary (blue; dark mode uses a lighter blue with dark text), secondary/muted/accent, border/input/ring, destructive, success, warning (+ foregrounds), sidebar-*, chart-1..5. AA contrast checked for text roles on background, card and accent.
- Surfaces: `.surface` (card bg, 1px border, radius-xl, `--shadow-card`: soft in light, none in dark). `.num` = tabular figures.
- Type: Geist Sans (UI + headings, weight/size only), Geist Mono for hosts, URLs, domains.
- Motion: --ease-out / --ease-in-out / --ease-drawer, --dur-press 120 / small 160 / menu 200 / panel 300 ms. Reduced motion: no pulses, no slide/zoom.

## Decisions
- 2026-11-09: no mockups/directions (user). Build straight into feat/frontend-refresh.
- 2026-11-09: one blue accent; semantic success/warning/destructive replace raw green/red/amber classes everywhere.
- 2026-11-09: below lg the sidebar becomes a top bar + drawer (the icon rail on phones wasted ~90 px).
- 2026-11-09: Overview order is stats, instances, 24 h chart, top lists (node health first); bulk Enable/Disable All moved into a "Blocking" menu so Disable All is never one stray click.
- 2026-11-09: no entrance animations (daily-use tool); sidebar collapse is instant (width animation reflowed the page).
- 2026-11-09: settings forms share max-w-3xl; data-table pages use the full width; tables scroll sideways on phones.

