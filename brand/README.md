# The AgentAction brand

Everything here is plain SVG: two shapes, one gap, no bitmaps and no fonts to
licence. It is small on purpose, because a mark that only works at 512px is not
a mark, it is an illustration.

## What the mark means

<p align="left">
  <img src="mark.svg" alt="" width="88" height="88">
</p>

A gate, held shut. The enclosure is the agent: free to work inside, with one
opening. The green stroke is the approval, and it is the only thing leaving
through that opening — nothing passes until a person lets it.

Read it in that order and the product explains itself: the blue holds, the
green releases, the gap is where a human has to stand.

## The assets

| File | What it is |
|---|---|
| `mark.svg` | The mark on its own, 128×128. Transparent background. Use it anywhere the name is already on the page. |
| `wordmark.svg` | The mark, the name and the slogan beneath it, 560×128. Built for a dark background — the name is drawn in the light text colour. |
| `wordmark.png` | The same at 1120×256, for anywhere that will not take an SVG. Re-render it whenever the SVG changes. |
| `icon-source.svg` | 1024×1024 app icon: the mark on the dark gradient. The source for `app/assets/icon.png` and the iOS icon. |
| `adaptive-source.svg` | 1024×1024 Android adaptive foreground. The mark sits inside the safe circle, so it survives being masked into a circle, a squircle or a rounded square. |
| `bg.svg` | The flat ink background layer that goes behind it. |

The PNGs under `app/assets/` are renders of these, at the sizes Expo asks for.
Change a source here and re-render rather than editing a PNG. The exception is
`app/assets/android-icon-monochrome.png`, which has no source in this
directory and predates the rest.

## Words

| Item | Text |
|---|---|
| Name | AgentAction — one word, two capitals. Not "Agent Action", not "agentaction" outside a URL or a package name. |
| Slogan | **Agents act. Your users decide.** |
| Descriptor | Human approval for agent tool calls. |
| Short form | Your users decide. |

## Palette

| Role | Hex | Where it goes |
|---|---|---|
| Ink | `#0A0E1A` | The page. Everything is designed on it. |
| Surface | `#141B2D` | Cards, sheets, anything sitting on the ink. |
| Line | `#22304D` | Borders and dividers. Never text. |
| Text | `#F2F5FA` | Primary text. |
| Muted | `#8FA0BF` | Secondary text, labels, the slogan line in the wordmark. |
| Brand | `#5B8CFF` | The enclosure, links, the "Action" half of the wordmark. |
| Approve | `#2FD98B` | The approval stroke, and approval everywhere else. |
| Deny | `#FF5A5F` | Deny, and only deny. |
| Hold | `#FFB020` | Waiting, expiring, needs attention. |

The mark's enclosure is a gradient between `#7FA6FF` and `#4C7BFF`, either side
of the brand blue, so the stroke has some depth at large sizes without
introducing a second colour.

## Rules

- **Do not recolour the mark.** No single-colour version, no inverted version,
  no brand-of-the-month version. It is two colours because it says two things.
- **The green stroke is always the approval.** Never use `#2FD98B` for a
  decoration elsewhere in the same view, and never draw the approval stroke in
  anything else. If green appears twice on a screen, one of them is wrong.
- **Clear space**: keep a margin of at least one stroke width — a tenth of the
  mark's height — on all four sides. Nothing crosses it.
- **Minimum size**: 20px for the mark, 120px wide for the wordmark. Below that
  use the mark alone.
- **Do not rotate, stretch, outline, add a shadow, or put the mark inside
  another shape.** It already has a shape.
- **Backgrounds**: ink, or a dark neutral. The mark holds up on white, but the
  wordmark does not — its name is drawn in `#F2F5FA`.
- The app takes on the integrator's brand after pairing, which is the point of
  the product. This mark belongs to AgentAction itself: the repository, the
  docs and the unbranded build. It does not belong on a customer's screen next
  to their agency's logo.
