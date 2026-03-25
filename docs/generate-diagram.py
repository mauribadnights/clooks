#!/usr/bin/env python3
"""Generate clooks architecture diagram as PNG using matplotlib."""

import matplotlib.pyplot as plt
import matplotlib.patches as patches
from pathlib import Path

# --- Colors ---
BG = "#FFFFFF"
BOX_CLAUDE = "#F0F4FF"
BOX_DAEMON = "#F5F0FF"
BOX_HANDLER_SCRIPT = "#FFF8F0"
BOX_HANDLER_INLINE = "#F0FFF4"
BOX_HANDLER_LLM = "#FFF0F5"
BORDER_CLAUDE = "#4A7ADB"
BORDER_DAEMON = "#7C4DDB"
BORDER_HANDLER = "#999999"
ARROW_COLOR = "#555555"
TEXT_MAIN = "#1A1A2E"
TEXT_DIM = "#666666"
ACCENT = "#7C4DDB"


def draw_box(ax, x, y, w, h, label, sublabel=None, facecolor="#F5F5F5",
             edgecolor="#999999", fontsize=11, sublabel_fontsize=8.5):
    """Draw a rounded rectangle with centered text."""
    rect = patches.FancyBboxPatch(
        (x, y), w, h,
        boxstyle="round,pad=0.02",
        facecolor=facecolor,
        edgecolor=edgecolor,
        linewidth=1.5,
    )
    ax.add_patch(rect)
    ty = y + h / 2 if sublabel is None else y + h * 0.58
    ax.text(x + w / 2, ty, label, ha="center", va="center",
            fontsize=fontsize, fontweight="bold", color=TEXT_MAIN)
    if sublabel:
        ax.text(x + w / 2, y + h * 0.3, sublabel, ha="center", va="center",
                fontsize=sublabel_fontsize, color=TEXT_DIM, style="italic")


def draw_arrow(ax, x1, y1, x2, y2, label=None, color=ARROW_COLOR):
    """Draw an arrow with optional label."""
    ax.annotate(
        "", xy=(x2, y2), xytext=(x1, y1),
        arrowprops=dict(
            arrowstyle="->,head_width=0.3,head_length=0.15",
            color=color, lw=1.5,
        ),
    )
    if label:
        mx = (x1 + x2) / 2
        my = (y1 + y2) / 2 + 0.15
        ax.text(mx, my, label, ha="center", va="center",
                fontsize=8, color=TEXT_DIM,
                bbox=dict(boxstyle="round,pad=0.15", facecolor="white",
                          edgecolor="none", alpha=0.9))


def main():
    fig, ax = plt.subplots(1, 1, figsize=(14, 7))
    ax.set_xlim(0, 14)
    ax.set_ylim(0, 7)
    ax.set_aspect("equal")
    ax.axis("off")
    fig.patch.set_facecolor(BG)

    # Title
    ax.text(7, 6.6, "clooks architecture", ha="center", va="center",
            fontsize=16, fontweight="bold", color=TEXT_MAIN)
    ax.text(7, 6.25, "Persistent hook runtime for Claude Code",
            ha="center", va="center", fontsize=10, color=TEXT_DIM)

    # --- Claude Code box (left) ---
    draw_box(ax, 0.5, 2.0, 2.8, 3.5,
             "Claude Code", "hook events",
             facecolor=BOX_CLAUDE, edgecolor=BORDER_CLAUDE, fontsize=13)

    # Hook event labels inside Claude box
    events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]
    for i, ev in enumerate(events):
        ey = 4.8 - i * 0.55
        ax.text(1.9, ey, ev, ha="center", va="center",
                fontsize=7.5, color=BORDER_CLAUDE, family="monospace")

    # --- Daemon box (center) ---
    draw_box(ax, 5.0, 1.5, 3.5, 4.5,
             "clooks daemon", "localhost:7890",
             facecolor=BOX_DAEMON, edgecolor=BORDER_DAEMON, fontsize=13)

    # Internal components
    components = [
        ("Router", 4.6),
        ("Auth + Rate Limit", 4.1),
        ("Prefetch Context", 3.6),
        ("Dependency DAG", 3.1),
        ("Metrics + Costs", 2.6),
        ("Circuit Breaker", 2.1),
    ]
    for label, cy in components:
        ax.text(6.75, cy, label, ha="center", va="center",
                fontsize=7.5, color=BORDER_DAEMON, family="monospace")

    # --- Handler boxes (right) ---
    handler_groups = [
        ("Script", "sh -c command", BOX_HANDLER_SCRIPT, 5.0),
        ("Inline", "JS module import", BOX_HANDLER_INLINE, 3.7),
        ("LLM", "Anthropic API", BOX_HANDLER_LLM, 2.4),
    ]
    for label, sub, color, hy in handler_groups:
        draw_box(ax, 10.0, hy, 2.8, 0.9,
                 f"{label} Handler", sub,
                 facecolor=color, edgecolor=BORDER_HANDLER, fontsize=10,
                 sublabel_fontsize=7.5)

    # --- Arrows ---
    # Claude -> Daemon
    draw_arrow(ax, 3.3, 3.75, 5.0, 3.75, "HTTP POST")

    # Daemon -> Handlers
    draw_arrow(ax, 8.5, 4.5, 10.0, 5.35)
    draw_arrow(ax, 8.5, 3.75, 10.0, 4.15)
    draw_arrow(ax, 8.5, 3.0, 10.0, 2.85)

    # Response arrow (bottom, going back)
    draw_arrow(ax, 5.0, 1.8, 3.3, 1.8, "JSON response")

    # --- Bootstrap annotation ---
    ax.text(1.9, 1.3, "SessionStart fires", ha="center", va="center",
            fontsize=8, color=TEXT_DIM)
    ax.text(1.9, 1.0, "clooks ensure-running", ha="center", va="center",
            fontsize=8, color=ACCENT, fontweight="bold", family="monospace")
    draw_arrow(ax, 2.8, 1.15, 5.0, 1.6, color=ACCENT)

    # --- Legend ---
    ax.text(10.5, 1.5, "Handler Types:", ha="center", va="center",
            fontsize=8.5, fontweight="bold", color=TEXT_MAIN)
    legend_items = [
        ("Script", "~5-35ms (subprocess)", BOX_HANDLER_SCRIPT),
        ("Inline", "<1ms (in-process)", BOX_HANDLER_INLINE),
        ("LLM", "Network-bound (API)", BOX_HANDLER_LLM),
    ]
    for i, (name, desc, color) in enumerate(legend_items):
        ly = 1.1 - i * 0.35
        rect = patches.FancyBboxPatch(
            (9.3, ly - 0.1), 0.3, 0.2,
            boxstyle="round,pad=0.02",
            facecolor=color, edgecolor=BORDER_HANDLER, linewidth=0.8,
        )
        ax.add_patch(rect)
        ax.text(9.75, ly, f"{name}: {desc}", ha="left", va="center",
                fontsize=7, color=TEXT_DIM)

    # Save
    out_path = Path(__file__).parent / "architecture.png"
    fig.savefig(out_path, dpi=200, bbox_inches="tight",
                facecolor=BG, edgecolor="none")
    plt.close(fig)
    print(f"Saved: {out_path}")


if __name__ == "__main__":
    main()
