#!/usr/bin/env python3
"""Generate clooks architecture diagram as PNG using matplotlib."""

import matplotlib.pyplot as plt
import matplotlib.patches as patches
from pathlib import Path

# --- Colors ---
BG = "#FFFFFF"
CLR_CLAUDE_FILL = "#E8F0FE"
CLR_CLAUDE_EDGE = "#4285F4"
CLR_DAEMON_FILL = "#F3E8FF"
CLR_DAEMON_EDGE = "#7C3AED"
CLR_SCRIPT_FILL = "#FFF7ED"
CLR_SCRIPT_EDGE = "#EA580C"
CLR_INLINE_FILL = "#ECFDF5"
CLR_INLINE_EDGE = "#059669"
CLR_LLM_FILL = "#FFF1F2"
CLR_LLM_EDGE = "#E11D48"
CLR_ARROW = "#475569"
CLR_TEXT = "#1E293B"
CLR_DIM = "#64748B"
CLR_ACCENT = "#7C3AED"

FONT = "sans-serif"


def rounded_box(ax, x, y, w, h, facecolor, edgecolor, lw=1.8):
    """Draw a FancyBboxPatch and return it."""
    rect = patches.FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0.12",
        facecolor=facecolor,
        edgecolor=edgecolor,
        linewidth=lw,
    )
    ax.add_patch(rect)
    return rect


def arrow(ax, x1, y1, x2, y2, label=None, label_offset_y=0.18, color=CLR_ARROW):
    """Draw an arrow with optional centered label."""
    ax.annotate(
        "", xy=(x2, y2), xytext=(x1, y1),
        arrowprops=dict(
            arrowstyle="->,head_width=0.25,head_length=0.12",
            color=color, lw=1.6, connectionstyle="arc3,rad=0",
        ),
    )
    if label:
        mx = (x1 + x2) / 2
        my = (y1 + y2) / 2 + label_offset_y
        ax.text(mx, my, label, ha="center", va="center",
                fontsize=9, color=CLR_DIM, family=FONT,
                bbox=dict(boxstyle="round,pad=0.2", facecolor="white",
                          edgecolor="#E2E8F0", linewidth=0.8, alpha=0.95))


def main():
    fig, ax = plt.subplots(figsize=(14, 6))
    ax.set_xlim(0, 14)
    ax.set_ylim(0, 6)
    ax.set_aspect("equal")
    ax.axis("off")
    fig.patch.set_facecolor(BG)

    # ── Title ──
    ax.text(7, 5.65, "clooks architecture", ha="center", va="center",
            fontsize=15, fontweight="bold", color=CLR_TEXT, family=FONT)
    ax.text(7, 5.35, "Persistent hook runtime for Claude Code",
            ha="center", va="center", fontsize=9.5, color=CLR_DIM, family=FONT)

    # =====================================================================
    # COLUMN 1 — Claude Code (left)
    # =====================================================================
    cx, cy, cw, ch = 0.4, 1.4, 2.8, 3.6
    rounded_box(ax, cx, cy, cw, ch, CLR_CLAUDE_FILL, CLR_CLAUDE_EDGE)

    ax.text(cx + cw / 2, cy + ch - 0.35, "Claude Code",
            ha="center", va="center", fontsize=12, fontweight="bold",
            color=CLR_CLAUDE_EDGE, family=FONT)

    ax.text(cx + cw / 2, cy + ch - 0.75, "Hook Events:",
            ha="center", va="center", fontsize=9, color=CLR_DIM, family=FONT)

    events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]
    for i, ev in enumerate(events):
        ax.text(cx + cw / 2, cy + ch - 1.15 - i * 0.42, ev,
                ha="center", va="center", fontsize=8.5, color=CLR_TEXT,
                family="monospace")

    # =====================================================================
    # COLUMN 2 — clooks daemon (center)
    # =====================================================================
    dx, dy, dw, dh = 5.2, 1.0, 3.4, 4.0
    rounded_box(ax, dx, dy, dw, dh, CLR_DAEMON_FILL, CLR_DAEMON_EDGE)

    ax.text(dx + dw / 2, dy + dh - 0.35, "clooks daemon",
            ha="center", va="center", fontsize=12, fontweight="bold",
            color=CLR_DAEMON_EDGE, family=FONT)

    ax.text(dx + dw / 2, dy + dh - 0.72, "localhost:7890",
            ha="center", va="center", fontsize=9, color=CLR_DIM,
            family="monospace")

    features = ["Router", "Prefetch", "Dep Resolution", "Metrics", "Circuit Breaker"]
    bullet_x = dx + 0.5
    for i, feat in enumerate(features):
        fy = dy + dh - 1.2 - i * 0.42
        ax.text(bullet_x, fy, "\u2022  " + feat,
                ha="left", va="center", fontsize=8.5, color=CLR_TEXT,
                family=FONT)

    # =====================================================================
    # COLUMN 3 — Handler boxes (right)
    # =====================================================================
    hx, hw, hh = 10.2, 3.2, 0.9
    handler_gap = 1.2

    handlers = [
        ("Script Handler", "~5\u201335 ms", CLR_SCRIPT_FILL, CLR_SCRIPT_EDGE),
        ("Inline Handler", "<1 ms", CLR_INLINE_FILL, CLR_INLINE_EDGE),
        ("LLM Handler", "API call", CLR_LLM_FILL, CLR_LLM_EDGE),
    ]

    # Position handlers: top one aligns near daemon top, stack downward
    top_handler_y = 3.8
    handler_centers = []

    for i, (label, timing, fill, edge) in enumerate(handlers):
        hy = top_handler_y - i * handler_gap
        rounded_box(ax, hx, hy, hw, hh, fill, edge)
        ax.text(hx + hw / 2, hy + hh / 2 + 0.12, label,
                ha="center", va="center", fontsize=10.5, fontweight="bold",
                color=edge, family=FONT)
        ax.text(hx + hw / 2, hy + hh / 2 - 0.2, timing,
                ha="center", va="center", fontsize=8.5, color=CLR_DIM,
                family="monospace")
        handler_centers.append(hy + hh / 2)

    # =====================================================================
    # ARROWS
    # =====================================================================

    # Claude Code -> Daemon  (horizontal, at midpoint)
    mid_y = cy + ch / 2
    arrow(ax, cx + cw, mid_y, dx, mid_y, label="HTTP POST", label_offset_y=0.22)

    # Daemon -> each Handler
    daemon_right_x = dx + dw
    for hc_y in handler_centers:
        arrow(ax, daemon_right_x, hc_y, hx, hc_y)

    # Daemon -> Claude Code return arrow (below the forward arrow)
    return_y = mid_y - 0.55
    arrow(ax, dx, return_y, cx + cw, return_y,
          label="JSON response", label_offset_y=-0.25, color="#94A3B8")

    # =====================================================================
    # FOOTNOTE — bootstrap note
    # =====================================================================
    ax.text(7, 0.35, 'SessionStart fires "clooks ensure-running" to bootstrap daemon',
            ha="center", va="center", fontsize=8.5, color=CLR_DIM, family=FONT,
            style="italic",
            bbox=dict(boxstyle="round,pad=0.3", facecolor="#F8FAFC",
                      edgecolor="#E2E8F0", linewidth=0.8))

    # ── Save ──
    out_path = Path(__file__).parent / "architecture.png"
    fig.savefig(out_path, dpi=300, bbox_inches="tight",
                facecolor=BG, edgecolor="none")
    plt.close(fig)
    print(f"Saved: {out_path}  ({out_path.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
