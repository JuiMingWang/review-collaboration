#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate the review-collaboration v1 detailed control-flow diagram (SVG), in
both Traditional Chinese and English.

Deterministic layout generator: every coordinate is computed, not eyeballed,
so re-running after a content edit doesn't require re-tuning pixels by hand.
Outputs, per language (`zh` / `en`):
  flow-diagram.<lang>.svg        - standalone file for manual inspection
  flow-diagram.<lang>.embed.svg  - bare <svg>...</svg> fragment for pasting into an HTML page

2026-08-18 rewrite: fixed a text-sizing bug where edge-label pills, node
badges, and data pills were sized with a flat per-character width constant
tuned for Latin text (`13 + 7.3*len(s)`), which underestimates CJK glyph
width by roughly 40-50% at this font size — the rendered text overflowed
its background pill and visually overlapped neighboring lines/nodes.
Replaced with `text_w()`, which weights CJK/fullwidth characters and
Latin/digit characters differently. Also added English-language output
(previously Traditional-Chinese-only) via a small per-string translation
table and a `build(lang)` wrapper around what used to be top-level script
state, so the two languages can be generated from one run without either
one leaking layout state into the other.

Not runtime evidence; purely a diagramming tool to understand the interface.
"""
import html

# ---------- text width estimation (fixes the CJK-underestimate overflow bug) ----------
def _is_wide(ch):
    o = ord(ch)
    # CJK Unified Ideographs + common punctuation/fullwidth ranges used in this diagram's labels
    return (
        0x1100 <= o <= 0x115F or 0x2E80 <= o <= 0xA4CF or 0xAC00 <= o <= 0xD7A3
        or 0xF900 <= o <= 0xFAFF or 0xFF00 <= o <= 0xFFEF or 0x3000 <= o <= 0x303F
    )

def text_w(s, size, wide_factor=1.05, narrow_factor=0.60):
    """Rough rendered width in px for `s` at font-size `size` (Consolas/monospace-ish),
    weighting CJK/fullwidth characters (~1 em) separately from Latin/digits/punctuation (~0.6 em)."""
    w = 0.0
    for ch in s:
        w += size * (wide_factor if _is_wide(ch) else narrow_factor)
    return w

def build(lang):
    assert lang in ("zh", "en")
    def t(zh, en):
        return zh if lang == "zh" else en

    # ---------- layout constants ----------
    MARGIN = 40
    LANE_W = 340
    LANE_GAP = 40
    N_LANES = 4
    LANE_LEFT = [MARGIN + i * (LANE_W + LANE_GAP) for i in range(N_LANES)]
    LANE_CX = [x + LANE_W / 2 for x in LANE_LEFT]
    REC_LEFT = LANE_LEFT[3] + LANE_W + LANE_GAP + 40
    REC_W = 300
    REC_CX = REC_LEFT + REC_W / 2
    TOTAL_W = REC_LEFT + REC_W + MARGIN

    LANE_NAMES = [t("使用者", "User"), "Producer／Controller", "PowerShell adapter", "Codex Reviewer"]
    LANE_COLORS = ["var(--blue)", "var(--teal)", "var(--amber)", "var(--red)"]
    LANE_SOFT = ["var(--blue-soft)", "var(--teal-soft)", "var(--amber-soft)", "var(--red-soft)"]

    nodes = {}
    elems = []
    edge_elems = []

    def esc(s):
        return html.escape(s, quote=True)

    def fo_text(cx, cy, w, h, title, lines, title_size=15, body_size=12.3, color="var(--ink)", muted="var(--muted)", align="left", pad=10):
        x = cx - w / 2
        y = cy - h / 2
        body_html = "".join(f'<div style="margin-top:3px;color:{muted};line-height:1.38">{l}</div>' for l in lines)
        ta = "center" if align == "center" else "left"
        return (
            f'<foreignObject x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}">'
            f'<div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;box-sizing:border-box;'
            f'padding:{pad}px;font-family:\'Microsoft JhengHei\',\'PingFang TC\',\'Noto Sans TC\',sans-serif;'
            f'font-size:{body_size}px;text-align:{ta};overflow:hidden;display:flex;flex-direction:column;justify-content:center">'
            f'<div style="font-weight:700;font-size:{title_size}px;color:{color};line-height:1.3">{title}</div>'
            f'{body_html}</div></foreignObject>'
        )

    def register(node_id, cx, cy, w, h):
        nodes[node_id] = dict(cx=cx, cy=cy, w=w, h=h,
                               top=(cx, cy - h / 2), bottom=(cx, cy + h / 2),
                               left=(cx - w / 2, cy), right=(cx + w / 2, cy))

    def rect_node(node_id, lane_idx_or_cx=None, cy=0, title="", lines=(), w=None, h=100,
                  role=None, dashed=False, fill=None, stroke=None, badge=None, center_lane=None):
        if center_lane is not None:
            lanes = center_lane
            cx = (LANE_CX[lanes[0]] + LANE_CX[lanes[-1]]) / 2
            w = w or (LANE_CX[lanes[-1]] - LANE_CX[lanes[0]] + LANE_W - 20)
        elif isinstance(lane_idx_or_cx, int) and lane_idx_or_cx in (0, 1, 2, 3):
            cx = LANE_CX[lane_idx_or_cx]
            w = w or (LANE_W - 20)
        else:
            cx = lane_idx_or_cx
            w = w or 300
        register(node_id, cx, cy, w, h)
        stroke = stroke or (LANE_COLORS[role] if role is not None else "var(--muted)")
        fill = fill or (LANE_SOFT[role] if role is not None else "var(--surface-2)")
        dash = ' stroke-dasharray="7,5"' if dashed else ""
        rx = 12
        s = f'<rect x="{cx-w/2:.1f}" y="{cy-h/2:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="2"{dash}/>'
        elems.append(s)
        elems.append(fo_text(cx, cy, w, h, title, lines))
        if badge:
            bw = 16 + text_w(badge, 10.5)
            bx = cx + w/2 - bw - 8
            by = cy - h/2 + 8
            elems.append(f'<rect x="{bx:.1f}" y="{by:.1f}" width="{bw:.1f}" height="20" rx="10" fill="var(--surface)" stroke="{stroke}" stroke-width="1.5"/>')
            elems.append(f'<text x="{bx+bw/2:.1f}" y="{by+14:.1f}" font-size="10.5" font-weight="700" fill="{stroke}" text-anchor="middle" font-family="Consolas,monospace">{esc(badge)}</text>')
        return node_id

    def diamond_node(node_id, cx, cy, title, lines=(), w=340, h=150, stroke="var(--blue)", fill="var(--blue-soft)"):
        register(node_id, cx, cy, w, h)
        pts = f"{cx},{cy-h/2} {cx+w/2},{cy} {cx},{cy+h/2} {cx-w/2},{cy}"
        elems.append(f'<polygon points="{pts}" fill="{fill}" stroke="{stroke}" stroke-width="2.5"/>')
        elems.append(fo_text(cx, cy, w*0.62, h*0.62, title, lines, title_size=13.5, body_size=11, align="center", pad=4))
        return node_id

    def pill_data(node_id, cx, cy, text, w=None):
        w = w or (28 + text_w(text, 11.5))
        h = 30
        register(node_id, cx, cy, w, h)
        elems.append(f'<rect x="{cx-w/2:.1f}" y="{cy-h/2:.1f}" width="{w:.1f}" height="{h}" rx="15" fill="var(--surface)" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="3,3"/>')
        elems.append(f'<text x="{cx:.1f}" y="{cy+4:.1f}" font-size="11.5" fill="var(--ink)" text-anchor="middle" font-family="Consolas,monospace">{esc(text)}</text>')
        return node_id

    def side(pt_dict, s):
        return pt_dict[s]

    def arrow(a_id, a_side, b_id, b_side, label="", dashed=False, color="var(--muted)", waypoints=None, lw=2.2, loop=False):
        a = nodes[a_id]; b = nodes[b_id]
        p0 = side(a, a_side)
        p1 = side(b, b_side)
        pts = [p0] + (waypoints or []) + [p1]
        if not waypoints:
            if abs(p0[0] - p1[0]) < 2:
                d = f"M {p0[0]:.1f},{p0[1]:.1f} L {p1[0]:.1f},{p1[1]:.1f}"
            else:
                ymid = (p0[1] + p1[1]) / 2
                d = f"M {p0[0]:.1f},{p0[1]:.1f} L {p0[0]:.1f},{ymid:.1f} L {p1[0]:.1f},{ymid:.1f} L {p1[0]:.1f},{p1[1]:.1f}"
        else:
            d = f"M {p0[0]:.1f},{p0[1]:.1f} " + " ".join(f"L {x:.1f},{y:.1f}" for x, y in (list(waypoints) + [p1]))
        dash = ' stroke-dasharray="8,6"' if dashed else ""
        marker = "url(#arrowhead-loop)" if loop else "url(#arrowhead)"
        edge_elems.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{lw}"{dash} marker-end="{marker}"/>')
        if label:
            mx = pts[len(pts)//2][0]
            my = pts[len(pts)//2][1]
            lw_box = 16 + text_w(label, 11.5)
            box_x = mx - lw_box / 2
            box_x = max(8, min(box_x, TOTAL_W - 8 - lw_box))
            text_x = box_x + lw_box / 2
            edge_elems.append(f'<rect x="{box_x:.1f}" y="{my-11:.1f}" width="{lw_box:.1f}" height="20" rx="4" fill="var(--bg)" opacity="0.92"/>')
            edge_elems.append(f'<text x="{text_x:.1f}" y="{my+4:.1f}" font-size="11.5" fill="{color}" text-anchor="middle" font-family="Consolas,monospace" font-weight="700">{esc(label)}</text>')

    def lane_label(cx, text, color):
        elems.append(f'<text x="{cx:.1f}" y="26" font-size="14" font-weight="700" fill="{color}" text-anchor="middle" font-family="Consolas,monospace">{esc(text)}</text>')

    # ================= layout =================
    y = 60
    def adv(dy):
        nonlocal y
        y += dy
        return y

    lane_top = 40
    for i in range(4):
        elems.append(f'<rect x="{LANE_LEFT[i]}" y="{lane_top}" width="{LANE_W}" height="30" rx="6" fill="{LANE_SOFT[i]}" stroke="{LANE_COLORS[i]}" stroke-width="1.5"/>')
        lane_label(LANE_CX[i], LANE_NAMES[i], LANE_COLORS[i])
    rec_header_label = t("中斷／恢復安全分支（側欄，待驗證）", "Interrupt／recovery safety branch (sidebar, unverified)")
    rec_header_w = max(REC_W, 24 + text_w(rec_header_label, 13))
    elems.append(f'<rect x="{REC_CX-rec_header_w/2:.1f}" y="{lane_top}" width="{rec_header_w:.1f}" height="30" rx="6" fill="var(--red-soft)" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="5,4"/>')
    elems.append(f'<text x="{REC_CX:.1f}" y="26" font-size="13" font-weight="700" fill="var(--red)" text-anchor="middle" font-family="Consolas,monospace">{esc(rec_header_label)}</text>')

    y = 110
    rect_node("start", center_lane=(0,3), cy=y, title=t("使用者觸發 review-collaboration", "User triggers review-collaboration"), lines=[t("提出審查主題，或要求恢復既有 review_id", "Proposes a review topic, or asks to resume an existing review_id")], h=64, role=0)

    y = adv(110)
    rect_node("s0a", 1, y, t("Step 0A　選定審查範圍", "Step 0A  Scope the review"), [
        t("使用者已指定主題：確認邊界", "User specified a topic: confirm boundaries"),
        t("未指定：Producer 從可見對話列候選", "Not specified: Producer lists candidates from visible conversation"),
        t("候選可能因壓縮／跨 Session 而不完整", "Candidates may be incomplete due to compaction／cross-session gaps")], h=132, role=1)
    rect_node("s0b", 2, y, t("Step 0B　status（唯讀）", "Step 0B  status (read-only)"), [
        t("查詢 .review-collaboration/active、history 索引", "Query .review-collaboration/active, history index"),
        t("讀出 review-state.json 目前 revision", "Read the current revision from review-state.json")], h=118, role=2)
    arrow("s0a", "right", "s0b", "left")
    arrow("start", "bottom", "s0a", "top")

    y = adv(150)
    diamond_node("d_route", (LANE_CX[1]+LANE_CX[2])/2, y, t("Step 0B 案件路由", "Step 0B case routing"), [
        t("明確相同／明確不同／重疊或不確定／", "Clearly same／clearly different／overlap or uncertain／"),
        t("關鍵歷史缺失或矛盾", "critical history missing or contradictory")], w=430, h=190)
    arrow("s0a", "bottom", "d_route", "top")
    arrow("s0b", "bottom", "d_route", "top")

    y = adv(190)
    rect_node("n_new", 1, y, t("→ 明確不同：建立新案", "→ Clearly different: create new case"), [t("review_id 新建，human_state=preparing", "New review_id, human_state=preparing")], h=80, role=1)
    rect_node("n_resume", 2, y, t("→ 明確相同：依 checkpoint 復原", "→ Clearly same: resume from checkpoint"), [t("讀 durable revision，依 human_state 接續到對應步驟", "Read durable revision, resume at the step matching human_state")], h=80, role=2, dashed=True, badge=t("待驗證", "unverified"))
    arrow("d_route", "left", "n_new", "top", label=t("明確不同", "clearly different"))
    arrow("d_route", "right", "n_resume", "top", label=t("明確相同", "clearly same"))

    y = adv(120)
    diamond_node("d_user_route", LANE_CX[0], y, t("使用者裁決", "User decides"), [t("恢復既有 review_id，", "Resume existing review_id,"), t("或建立新案？", "or create a new case?")], w=300, h=140)
    arrow("d_route", "bottom", "d_user_route", "top", label=t("重疊／不確定", "overlap／uncertain"), waypoints=[(LANE_CX[0], nodes["d_route"]["bottom"][1]+40)])

    rec_y1 = y - 10
    rect_node("mrr", REC_CX, rec_y1, "manual_recovery_required", [
        t("「等待使用者」下的技術警告，不是第六個主要狀態", "A technical warning under waiting-user, not a 6th primary state"),
        t("使用者決定：資料補齊後重跑 status，或視為不可修復", "User decides: re-run status once data is complete, or treat as unrecoverable")], w=REC_W-20, h=120, role=None, stroke="var(--red)", fill="var(--red-soft)", dashed=True, badge=t("待驗證", "unverified"))
    arrow("d_route", "right", "mrr", "left", label=t("關鍵歷史缺失／矛盾", "critical history missing／contradictory"), dashed=True, color="var(--red)")

    y = adv(120)
    arrow("d_user_route", "left", "n_new", "left", label=t("選建立新案", "choose: create new"), dashed=True,
          waypoints=[(LANE_CX[0]-70, nodes["d_user_route"]["cy"]), (LANE_CX[0]-70, nodes["n_new"]["cy"]-20), (nodes["n_new"]["left"][0], nodes["n_new"]["cy"]-20)])
    arrow("d_user_route", "right", "n_resume", "left", label=t("選恢復既有", "choose: resume existing"), dashed=True,
          waypoints=[(LANE_CX[0]+90, nodes["d_user_route"]["cy"]-30), (nodes["n_resume"]["left"][0]-40, nodes["n_resume"]["cy"]+30), (nodes["n_resume"]["left"][0], nodes["n_resume"]["cy"]+30)])

    y = adv(70)
    rect_node("s1", 1, y, t("Step 1　整理送審內容", "Step 1  Prepare the review content"), [
        t("固定覆蓋：問題／結論／限制／關鍵前提查證／", "Fixed coverage: problem／conclusion／constraints／key-assumption verification／"),
        t("替代方案／未知／排除內容", "alternatives／unknowns／excluded content"),
        t("查證標籤：已查證／可查證未查證／純屬判斷", "Verification tags: verified／verifiable-unverified／judgment call"),
        t("匿名化：去權威歸屬，保留限制與證據", "Anonymize: strip attribution, keep constraints and evidence"),
        t("每次低成本搜尋 .review-collaboration/history", "Cheap search of .review-collaboration/history every time")], h=206, role=1)
    arrow("n_new", "bottom", "s1", "top")

    y = adv(230)
    rect_node("s2a", 1, y, t("Step 2　兩段式 checklist", "Step 2  Two-part checklist"), [
        t("先重建角色／輸入輸出／狀態／交接／外部依賴", "First rebuild roles／I-O／state／handoff／external deps"),
        t("再依六面向：目標對齊／完整性／可行性／", "Then six dimensions: goal alignment／completeness／feasibility／"),
        t("安全性／可逆性／成本", "safety／reversibility／cost"),
        t("固定開放式 ceiling-breaker 指令（不客製）", "Fixed open-ended ceiling-breaker instruction (not customized)")], h=166, role=1)
    arrow("s1", "bottom", "s2a", "top")

    y = adv(180)
    rect_node("s2b", center_lane=(0,1), cy=y, title=t("呈現完整送審 package", "Present the full review package"), lines=[
        t("使用者確認：已納入／刻意排除／尚未確定", "User confirms: included／deliberately excluded／still undecided"),
        t("可先看精簡版，但完整內容必須可查閱", "A condensed view is fine first, but full content must stay reachable")], h=100, role=0)
    arrow("s2a", "bottom", "s2b", "top")

    y = adv(140)
    diamond_node("d_confirm", LANE_CX[0], y, t("使用者確認完整 package？", "User confirms the full package?"), w=320, h=150)
    arrow("s2b", "bottom", "d_confirm", "top")

    y = adv(190)
    rect_node("confirm_pkg", 2, y, t("confirm-package　安全落地", "confirm-package  safe landing"), [
        t("暫存寫入 → 依完整 hash atomic rename", "Write to temp → atomic rename keyed by full hash"),
        t("→ 讀回驗 hash → expected-revision 原子更新 state", "→ read back, verify hash → atomic state update with expected-revision"),
        t("human_state → confirmed-recoverable", "human_state → confirmed-recoverable")], h=140, role=2, badge=t("恢復起點", "recovery anchor"))
    arrow("d_confirm", "bottom", "confirm_pkg", "top", label=t("確認", "confirm"))
    arrow("d_confirm", "left", "s1", "left", label=t("需修改", "needs changes"), dashed=True,
          waypoints=[(LANE_CX[0]-190, nodes["d_confirm"]["cy"]), (LANE_CX[0]-190, nodes["s1"]["cy"]-150), (25, nodes["s1"]["cy"]-150), (25, nodes["s1"]["cy"])])

    pill_data("dp_hash", LANE_CX[3]+10, y-70, t("package hash（完整 SHA-256）", "package hash (full SHA-256)"), w=None)
    pill_data("dp_state1", LANE_CX[3]+10, y+15, "review-state.json rev++", w=None)
    arrow("confirm_pkg", "right", "dp_hash", "left", color="var(--muted)")

    y = adv(190)
    rect_node("advance1", 1, y, t("Producer 呼叫 advance", "Producer calls advance"), [t("review_id ＋ expected revision", "review_id + expected revision")], h=80, role=1)
    arrow("confirm_pkg", "bottom", "advance1", "right", waypoints=[(LANE_CX[2], y), ])

    y = adv(130)
    cp_labels = ["prepared", "launch_intent_saved", "thread_captured", "result_validated", "state_committed"]
    cp_w = LANE_W - 20
    rect_node("cp_strip", 2, y, t("Step 3 技術 checkpoint 鏈", "Step 3 technical checkpoint chain"), [], h=104, role=2, dashed=True, badge=t("待驗證", "unverified"))
    elems.append(fo_text(LANE_CX[2], y+16, cp_w-20, 56, "", [
        '<span style="font-family:Consolas,monospace;font-size:10.6px">' + " → ".join(cp_labels[:3]) + '</span>',
        '<span style="font-family:Consolas,monospace;font-size:10.6px">' + " → ".join(cp_labels[3:]) + '</span>'
    ]))
    arrow("advance1", "bottom", "cp_strip", "top")

    rect_node("r2", REC_CX, y-40, t("R：launch intent 已存但啟動與否不明", "R: launch intent saved but start unknown"), [t("查 PID／events／thread，仍不明才 MRR", "Check PID／events／thread; only MRR if still unknown")], h=96, role=None, stroke="var(--amber)", fill="var(--amber-soft)", dashed=True, w=REC_W-20)
    rect_node("r3", REC_CX, y+55, t("R：有 thread_id 但無可信結果", "R: has thread_id but no trustworthy result"), [t("只 resume 同一 thread，不重送", "Only resume the same thread, never resend")], h=84, role=None, stroke="var(--amber)", fill="var(--amber-soft)", dashed=True, w=REC_W-20)
    arrow("cp_strip", "right", "r2", "left", dashed=True, color="var(--amber)")
    arrow("cp_strip", "right", "r3", "left", dashed=True, color="var(--amber)")

    y = adv(150)
    rect_node("codex_call", 2, y, t("adapter 啟動／resume Codex", "adapter starts／resumes Codex"), [t("安全順序：驗證 package → 保存 launch intent →", "Safe order: verify package → save launch intent →"), t("啟動；看到 thread.started 立即持久化 thread_id", "start; persist thread_id the instant thread.started is seen")], h=100, role=2)
    rect_node("codex_exec", 3, y, t("Codex 獨立審查", "Codex reviews independently"), [t("讀取 package＋checklist＋ceiling-breaker", "Reads package + checklist + ceiling-breaker"), t("產生 schema 限定的結構化結果", "Produces a schema-constrained structured result")], h=100, role=3)
    arrow("cp_strip", "bottom", "codex_call", "top")
    arrow("codex_call", "right", "codex_exec", "left")
    pill_data("dp_thread", REC_CX, y, t("thread ID（capture 後立即持久化）", "thread ID (persisted the instant it's captured)"), w=None)
    arrow("codex_call", "right", "dp_thread", "left", color="var(--muted)", waypoints=[(LANE_CX[2]+LANE_W/2+150, y)])

    y = adv(140)
    rect_node("validate", 2, y, t("adapter 驗證結果", "adapter validates the result"), [t("process／exit code／completion event／", "process／exit code／completion event／"), t("schema／hash 全部可信才接受", "schema／hash — accepted only if all are trustworthy")], h=100, role=2, badge=t("待驗證", "unverified"))
    arrow("codex_exec", "bottom", "validate", "right", waypoints=[(LANE_CX[3], y), ])
    rect_node("r4", REC_CX, y, t("R：result 已驗證但 state 未 commit", "R: result validated but state not committed"), [t("只做本地冪等 commit，不再呼叫 Codex", "Only a local idempotent commit, never call Codex again")], h=94, role=None, stroke="var(--amber)", fill="var(--amber-soft)", dashed=True, w=REC_W-20)
    arrow("validate", "right", "r4", "left", dashed=True, color="var(--amber)")

    y = adv(120)
    rect_node("state_commit", 2, y, "state_committed", [t("原子推進 review-state.json；", "Atomically advance review-state.json;"), t("human_state 全程維持 reviewing", "human_state stays reviewing throughout")], h=80, role=2)
    arrow("validate", "bottom", "state_commit", "top")
    pill_data("dp_receipt", LANE_CX[3]+10, y, t("operation receipt（每次呼叫）", "operation receipt (every call)"), w=None)
    arrow("state_commit", "right", "dp_receipt", "left", color="var(--muted)")

    GAP_C = (LANE_LEFT[2] + LANE_W + LANE_LEFT[3]) / 2
    GAP_D = (LANE_LEFT[3] + LANE_W + REC_LEFT) / 2

    y = adv(110)
    diamond_node("d_outcome", (LANE_CX[1]+LANE_CX[2])/2, y, t("頂層 outcome（schema 限定）", "Top-level outcome (schema-constrained)"), [
        "CONSENSUS／ISSUES_RAISED／", "MATERIAL_REQUIRED"], w=430, h=170)
    arrow("state_commit", "bottom", "d_outcome", "right", waypoints=[(LANE_CX[2], y)])

    y_mat = adv(170)
    rect_node("mat_req", 3, y_mat, "MATERIAL_REQUIRED", [t("append-only material-request-r&lt;N&gt;.json", "append-only material-request-r&lt;N&gt;.json"), t("非 final attempt，只能同時要求補件", "Not a final attempt — can only request more material")], h=100, role=2, fill="var(--amber-soft)", stroke="var(--amber)")
    arrow("d_outcome", "right", "mat_req", "top", label="MATERIAL_REQUIRED", color="var(--amber)",
          waypoints=[(LANE_CX[3], nodes["d_outcome"]["cy"])])
    pill_data("dp_matreq", REC_CX, y_mat, t("material request（≤3段/案）", "material request (≤3 excerpts/case)"), w=None)
    arrow("mat_req", "right", "dp_matreq", "left", color="var(--muted)")

    y_mat = y_mat + 110
    rect_node("mat_decide", 3, y_mat, t("Producer／使用者一次決定", "Producer／User decides, once"), [
        t("提供已整理 excerpt（每案累計最多三段），", "Supply a prepared excerpt (max 3 total per case),"), t("或標記 unavailable —— 這是唯一停點", "or mark unavailable — this is the only stopping point")], h=100, role=0, fill="var(--amber-soft)", stroke="var(--amber)")
    arrow("mat_req", "bottom", "mat_decide", "top")

    y_mat = y_mat + 130
    rect_node("mat_submit", 3, y_mat, t("submit 補件 → advance 續同一 round", "submit the material → advance continues the same round"), [t("resume 同一 thread；不改 base package；", "resume the same thread; base package unchanged;"), t("不增加 round", "round count does not increase")], h=100, role=2, fill="var(--amber-soft)", stroke="var(--amber)")
    arrow("mat_decide", "bottom", "mat_submit", "top")
    arrow("mat_submit", "left", "codex_call", "bottom", label=t("同 round material loop", "same-round material loop"), dashed=False, color="var(--amber)",
          waypoints=[(GAP_C, y_mat), (GAP_C, nodes["codex_call"]["cy"]+60)], loop=True)

    y = adv(190)
    rect_node("fixpush", 1, y, t("ISSUES_RAISED：Producer 逐 issue 判斷", "ISSUES_RAISED: Producer judges issue-by-issue"), [t("Fix（具體修正文案，不改真實 target）", "Fix (concrete wording, doesn't touch the real target)"), t("或 Pushback（理由＋查證標籤）", "or Pushback (reasoning + verification tag)")], h=100, role=1, fill="var(--red-soft)", stroke="var(--red)")
    arrow("d_outcome", "left", "fixpush", "top", label="ISSUES_RAISED", color="var(--red)",
          waypoints=[(LANE_CX[1], nodes["d_outcome"]["cy"]+40)])

    y = adv(130)
    rect_node("submit_resp", 2, y, t("submit Producer response", "submit Producer response"), [t("immutable artifact；下一輪呼叫 Codex", "immutable artifact; next round calls Codex")], h=80, role=2, fill="var(--red-soft)", stroke="var(--red)")
    arrow("fixpush", "bottom", "submit_resp", "left", waypoints=[(LANE_CX[1], y), ])
    arrow("submit_resp", "right", "codex_call", "bottom", label=t("送出下一輪呼叫", "send next round"), color="var(--red)",
          waypoints=[(LANE_CX[2]+130, y), (LANE_CX[2]+130, nodes["codex_call"]["cy"]+90)], loop=True)

    y = adv(130)
    diamond_node("d_cap", 2, y, t("N ＜ cap？", "N < cap?"), [t("完成 final outcome 才計入 round", "Only a final outcome counts toward round")], w=280, h=140, stroke="var(--red)", fill="var(--red-soft)")
    arrow("submit_resp", "bottom", "d_cap", "top")
    arrow("d_cap", "left", "advance1", "left", label=t("N＜cap：下一 final round", "N<cap: next final round"), dashed=False, color="var(--red)",
          waypoints=[(LANE_CX[1]-150, y), (LANE_CX[1]-150, nodes["advance1"]["cy"])], loop=True)

    y = adv(150)
    rect_node("wait_arb", 0, y, t("N＝cap：waiting-user／arbitration", "N=cap: waiting-user／arbitration"), [t("禁止建立 N+1；等使用者仲裁", "N+1 forbidden; wait for user arbitration")], h=90, role=0, fill="var(--red-soft)", stroke="var(--red)")
    arrow("d_cap", "right", "wait_arb", "top", label=t("N＝cap", "N=cap"), color="var(--red)",
          waypoints=[(LANE_CX[0], nodes["d_cap"]["cy"])])

    y = adv(130)
    diamond_node("d_arb", LANE_CX[0], y, t("使用者仲裁", "User arbitrates"), [t("結束（放棄）；", "End (abandon);"), t("或新增實質輸入＋提高 cap", "or add substantive input + raise cap")], w=300, h=150, stroke="var(--red)", fill="var(--red-soft)")
    arrow("wait_arb", "bottom", "d_arb", "top")

    y = adv(150)
    rect_node("terminate", REC_CX, y, t("terminate（abandoned／superseded）", "terminate (abandoned／superseded)"), [
        t("仍產生自己的 terminal history／completion.json，", "Still produces its own terminal history／completion.json,"), t("不刪證據；不依賴 CONSENSUS 分支的節點", "evidence isn't deleted; doesn't depend on CONSENSUS-branch nodes")], w=REC_W-20, h=128, role=None, stroke="var(--red)", fill="var(--red-soft)")
    arrow("d_arb", "right", "terminate", "top", label=t("放棄", "abandon"), color="var(--red)",
          waypoints=[(LANE_CX[0]+180, nodes["d_arb"]["cy"])])
    arrow("mrr", "bottom", "terminate", "left", label=t("視為不可修復", "treat as unrecoverable"), dashed=True, color="var(--red)",
          waypoints=[(GAP_D, nodes["mrr"]["cy"]+70), (GAP_D, nodes["terminate"]["cy"])])
    arrow("d_arb", "left", "s1", "left", label=t("cap 後新增輸入回 Step1-2", "after cap, new input returns to Step 1-2"), dashed=False, color="var(--red)",
          waypoints=[(15, nodes["d_arb"]["cy"]), (15, nodes["s1"]["cy"]+40), (nodes["s1"]["left"][0], nodes["s1"]["cy"]+40)], loop=True)

    y = adv(80)
    rect_node("s5a1", 1, y, t("CONSENSUS → Step 5a 編譯 final package", "CONSENSUS → Step 5a compiles the final package"), [t("最終決策／已收斂 Fix／未解風險／", "Final decision／converged fixes／open risks／"), t("證據／各 issue 處置", "evidence／per-issue disposition")], h=100, role=1, fill="var(--green-soft)", stroke="var(--green)")
    arrow("d_outcome", "right", "s5a1", "left", label="CONSENSUS", color="var(--green)",
          waypoints=[(GAP_C, nodes["fixpush"]["cy"]), (GAP_C, y)])
    pill_data("dp_final", LANE_CX[3]+10, y, t("final package（完整 SHA-256）", "final package (full SHA-256)"), w=None)
    arrow("s5a1", "right", "dp_final", "left", color="var(--muted)")
    pill_data("dp_ledger", LANE_CX[3]+10, y-70, t("ledger snapshot（每個 completed round）", "ledger snapshot (every completed round)"), w=None)

    y = adv(140)
    diamond_node("d_approve", LANE_CX[0], y, t("使用者核准（綁定 exact hash）？", "User approves (binds exact hash)?"), w=320, h=150, stroke="var(--green)", fill="var(--green-soft)")
    arrow("s5a1", "bottom", "d_approve", "top", waypoints=[(LANE_CX[0], y-70), ])

    y = adv(190)
    rect_node("handoff", 2, y, t("產生 handoff ＋ target baseline", "Produce handoff + target baseline"), [t("review_id／final_package_hash／結論／Fix／", "review_id／final_package_hash／conclusion／fixes／"), t("target scope／constraints／follow_up_*", "target scope／constraints／follow_up_*")], h=110, role=2, fill="var(--green-soft)", stroke="var(--green)")
    arrow("d_approve", "bottom", "handoff", "top", label=t("核准", "approve"))
    pill_data("dp_handoff", LANE_CX[3]+10, y, "handoff packet", w=None)
    arrow("handoff", "right", "dp_handoff", "left", color="var(--muted)")

    arrow("d_approve", "left", "s5a1", "left", label=t("僅重排：重新 hash 再確認", "reorder only: re-hash and re-confirm"), dashed=True, color="var(--green)",
          waypoints=[(LANE_CX[0]-180, y-260), (LANE_CX[0]-180, nodes["s5a1"]["cy"]+40), (nodes["s5a1"]["left"][0], nodes["s5a1"]["cy"]+40)])
    arrow("d_approve", "left", "s1", "left", label=t("改動主張：回 Step1-2＋提高 cap", "changed claim: back to Step 1-2 + raise cap"), dashed=True, color="var(--green)",
          waypoints=[(5, nodes["d_approve"]["cy"]), (5, nodes["s1"]["cy"]+70), (nodes["s1"]["left"][0], nodes["s1"]["cy"]+70)])

    y = adv(170)
    rect_node("history", 2, y, t("保存 history bundle", "Save the history bundle"), [t("實體複製 final package／handoff／ledger", "Physically copies final package／handoff／ledger"), t("所傳遞引用的所有 immutable artifact", "and every immutable artifact they reference")], h=90, role=2, fill="var(--green-soft)", stroke="var(--green)")
    arrow("handoff", "bottom", "history", "top")
    pill_data("dp_history", LANE_CX[3]+10, y, "history bundle", w=None)
    arrow("history", "right", "dp_history", "left", color="var(--muted)")

    y = adv(140)
    rect_node("completion", 2, y, t("驗證必要 hash → 寫入 completion.json", "Verify required hashes → write completion.json"), [t("ended 的唯一權威證據", "The sole authoritative evidence of ended")], h=90, role=2, fill="var(--green-soft)", stroke="var(--green)", badge=t("待驗證", "unverified"))
    arrow("history", "bottom", "completion", "top")
    pill_data("dp_completion", LANE_CX[3]+10, y, "completion.json", w=None)
    arrow("completion", "right", "dp_completion", "left", color="var(--muted)")
    rect_node("r5", REC_CX, y-95, t("R：history 部分寫入，marker 未生效", "R: history partially written, marker not yet effective"), [t("冪等補齊並驗 hash，不得標 ended", "Idempotently complete it and verify hash — don't mark ended"), t("或先刪 active", "or delete active first")], h=120, role=None, stroke="var(--amber)", fill="var(--amber-soft)", dashed=True, w=REC_W-20)
    arrow("completion", "right", "r5", "left", dashed=True, color="var(--amber)")

    y = adv(140)
    rect_node("optional", 2, y, t("best effort：選配 review-log／ADR、清理 active／TEMP", "best effort: optional review-log／ADR, clean up active／TEMP"), [t("失敗只留 warning，不反轉核心結案", "Failure only leaves a warning — never reverts the core close-out")], h=94, role=2, dashed=True, fill="var(--surface-2)", badge=t("選配", "optional"))
    arrow("completion", "bottom", "optional", "top")

    y = adv(120)
    rect_node("end", center_lane=(0,3), cy=y, title="human_state = ended", lines=[
        "consensus-finalized／user-arbitrated-closed／abandoned／superseded"], h=80, role=None, stroke="var(--green)", fill="var(--green-soft)")
    arrow("optional", "bottom", "end", "top", waypoints=[(LANE_CX[2], y), ])
    arrow("terminate", "bottom", "end", "right", label=t("同樣驗 hash→completion.json→best effort 清理", "same: verify hash→completion.json→best-effort cleanup"), dashed=True, color="var(--red)",
          waypoints=[(GAP_D, nodes["terminate"]["cy"]+90), (GAP_D, y)])

    TOTAL_H = y + 100

    # ---------- node-vs-node overlap check (AABB, catches boxes bumped taller/wider colliding
    # with a neighbor in the same lane) ----------
    overlaps = []
    ids = list(nodes.keys())
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = nodes[ids[i]], nodes[ids[j]]
            ax0, ax1 = a["cx"] - a["w"] / 2, a["cx"] + a["w"] / 2
            ay0, ay1 = a["cy"] - a["h"] / 2, a["cy"] + a["h"] / 2
            bx0, bx1 = b["cx"] - b["w"] / 2, b["cx"] + b["w"] / 2
            by0, by1 = b["cy"] - b["h"] / 2, b["cy"] + b["h"] / 2
            ox = min(ax1, bx1) - max(ax0, bx0)
            oy = min(ay1, by1) - max(ay0, by0)
            if ox > 1 and oy > 1:
                overlaps.append((ids[i], ids[j], round(ox, 1), round(oy, 1)))

    svg_defs = '''
<defs>
  <marker id="arrowhead" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
    <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke"/>
  </marker>
  <marker id="arrowhead-loop" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
    <path d="M0,0 L8,4 L0,8 Z" fill="context-stroke"/>
  </marker>
</defs>
'''

    svg = f'<svg id="flowsvg" viewBox="0 0 {TOTAL_W:.0f} {TOTAL_H:.0f}" xmlns="http://www.w3.org/2000/svg" font-family="Microsoft JhengHei,PingFang TC,Noto Sans TC,sans-serif">'
    svg += svg_defs
    svg += "".join(edge_elems)
    svg += "".join(elems)
    svg += "</svg>"

    return svg, TOTAL_W, TOTAL_H, len(nodes), len(edge_elems), overlaps


if __name__ == "__main__":
    for lang in ("zh", "en"):
        svg, w, h, n_nodes, n_edges, overlaps = build(lang)
        with open(f"flow-diagram.{lang}.svg", "w", encoding="utf-8") as f:
            f.write(f'<?xml version="1.0" encoding="UTF-8"?>\n{svg}')
        with open(f"flow-diagram.{lang}.embed.svg", "w", encoding="utf-8") as f:
            f.write(svg)
        print(f"[{lang}] width={w:.0f} height={h:.0f} nodes={n_nodes} edges={n_edges} overlaps={len(overlaps)}")
        for o in overlaps:
            print(f"  OVERLAP: {o[0]} x {o[1]}  overlap_w={o[2]} overlap_h={o[3]}")
