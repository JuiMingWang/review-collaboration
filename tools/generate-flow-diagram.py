#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
產生 review-collaboration v1 詳細控制流圖（SVG）。

設計依據：
- 2026-08-16 diagnostic snapshot 文件第 13 節逐項決定（開發過程私有文件，不隨此 repo 附帶）
- 同日交接文件第 4 節新圖要求（同上，不隨此 repo 附帶）

這是一個確定性佈局產生器：所有座標由程式計算，不手動猜座標，方便之後調整節點內容時
重新產生而不必逐一調整像素。輸出：flow-diagram.svg（供人工檢視），以及一份可直接貼入
standalone HTML 的 <svg>...</svg> 片段 flow-diagram.embed.svg。

不是 runtime 證據；純粹是理解介面的畫圖工具。
"""
import html

# ---------- 版面常數 ----------
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

LANE_NAMES = ["使用者", "Producer／Controller", "PowerShell adapter", "Codex Reviewer"]
# 顏色一律用 CSS 變數，跟 standalone HTML 既有 :root／dark 色票共用同一套 token，
# 這樣這張 SVG 內嵌進頁面後才會隨淺色／深色模式自動切換，不會在深色模式下變成一塊突兀的亮色。
LANE_COLORS = ["var(--blue)", "var(--teal)", "var(--amber)", "var(--red)"]  # user, producer, script, reviewer
LANE_SOFT = ["var(--blue-soft)", "var(--teal-soft)", "var(--amber-soft)", "var(--red-soft)"]
C_RED, C_RED_SOFT = "var(--red)", "var(--red-soft)"
C_AMBER, C_AMBER_SOFT = "var(--amber)", "var(--amber-soft)"
C_GREEN, C_GREEN_SOFT = "var(--green)", "var(--green-soft)"
C_BLUE, C_BLUE_SOFT = "var(--blue)", "var(--blue-soft)"
C_INK, C_MUTED, C_LINE = "var(--ink)", "var(--muted)", "var(--line)"
C_SURFACE, C_SURFACE2 = "var(--surface)", "var(--surface-2)"

nodes = {}   # id -> dict(cx, cy, w, h, shape, anchors...)
elems = []   # svg fragments, drawn in order (so later = on top)
edge_elems = []  # drawn first (under nodes) except loop-back which we draw after

def esc(s):
    return html.escape(s, quote=True)

def fo_text(cx, cy, w, h, title, lines, title_size=15, body_size=12.3, color="var(--ink)", muted="var(--muted)", align="left", pad=10):
    """foreignObject 內文字，回傳 <foreignObject> 字串。"""
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
        bw = 15 + 8.5 * len(badge)
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
    w = w or (24 + 7.6 * len(text))
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
    d = f"M {p0[0]:.1f},{p0[1]:.1f} "
    pts = [p0] + (waypoints or []) + [p1]
    if not waypoints:
        # default orthogonal: straight if same x (vertical) else L-shape via vertical midpoint
        if abs(p0[0] - p1[0]) < 2:
            d += f"L {p1[0]:.1f},{p1[1]:.1f}"
        else:
            ymid = (p0[1] + p1[1]) / 2
            d = f"M {p0[0]:.1f},{p0[1]:.1f} L {p0[0]:.1f},{ymid:.1f} L {p1[0]:.1f},{ymid:.1f} L {p1[0]:.1f},{p1[1]:.1f}"
    else:
        d = f"M {p0[0]:.1f},{p0[1]:.1f} " + " ".join(f"L {x:.1f},{y:.1f}" for x, y in (list(waypoints) + [p1]))
    dash = ' stroke-dasharray="8,6"' if dashed else ""
    marker = "url(#arrowhead-loop)" if loop else "url(#arrowhead)"
    edge_elems.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{lw}"{dash} marker-end="{marker}"/>')
    if label:
        # place label near the path's first bend / midpoint, then clamp inside the canvas —
        # 靠近左／右邊界的走廊（例如 x<30 的左邊界回圈）用置中label會被 viewBox 邊界切掉，
        # 這裡把置中的 box 夾回 [8, TOTAL_W-8] 範圍內，寧可稍微偏離錨點也不要被裁切看不到字。
        mx = pts[len(pts)//2][0]
        my = pts[len(pts)//2][1]
        lw_box = 13 + 7.3 * len(label)
        box_x = mx - lw_box / 2
        box_x = max(8, min(box_x, TOTAL_W - 8 - lw_box))
        text_x = box_x + lw_box / 2
        edge_elems.append(f'<rect x="{box_x:.1f}" y="{my-11:.1f}" width="{lw_box:.1f}" height="20" rx="4" fill="var(--bg)" opacity="0.92"/>')
        edge_elems.append(f'<text x="{text_x:.1f}" y="{my+4:.1f}" font-size="11.5" fill="{color}" text-anchor="middle" font-family="Consolas,monospace" font-weight="700">{esc(label)}</text>')

def lane_label(cx, text, color):
    elems.append(f'<text x="{cx:.1f}" y="26" font-size="14" font-weight="700" fill="{color}" text-anchor="middle" font-family="Consolas,monospace">{esc(text)}</text>')

# ================= 版面配置開始 =================

y = 60
def adv(dy):
    global y
    y += dy
    return y

# --- lane header band ---
lane_top = 40
lane_bottom_placeholder = 5200  # 之後回填真正高度
for i in range(4):
    elems.append(f'<rect x="{LANE_LEFT[i]}" y="{lane_top}" width="{LANE_W}" height="30" rx="6" fill="{LANE_SOFT[i]}" stroke="{LANE_COLORS[i]}" stroke-width="1.5"/>')
    lane_label(LANE_CX[i], LANE_NAMES[i], LANE_COLORS[i])
elems.append(f'<rect x="{REC_LEFT}" y="{lane_top}" width="{REC_W}" height="30" rx="6" fill="var(--red-soft)" stroke="var(--red)" stroke-width="1.5" stroke-dasharray="5,4"/>')
elems.append(f'<text x="{REC_CX:.1f}" y="26" font-size="13" font-weight="700" fill="var(--red)" text-anchor="middle" font-family="Consolas,monospace">中斷／恢復安全分支（側欄，待驗證）</text>')

y = 110
rect_node("start", center_lane=(0,3), cy=y, title="使用者觸發 review-collaboration", lines=["提出審查主題，或要求恢復既有 review_id"], h=64, role=0)

y = adv(110)
rect_node("s0a", 1, y, "Step 0A　選定審查範圍", [
    "使用者已指定主題：確認邊界",
    "未指定：Producer 從可見對話列候選",
    "候選可能因壓縮／跨 Session 而不完整"], h=118, role=1)
rect_node("s0b", 2, y, "Step 0B　status（唯讀）", [
    "查詢 .review-collaboration/active、history 索引",
    "讀出 review-state.json 目前 revision"], h=118, role=2)
arrow("s0a", "right", "s0b", "left")
arrow("start", "bottom", "s0a", "top")

y = adv(150)
diamond_node("d_route", (LANE_CX[1]+LANE_CX[2])/2, y, "Step 0B 案件路由", [
    "明確相同／明確不同／重疊或不確定／",
    "關鍵歷史缺失或矛盾"], w=430, h=190)
arrow("s0a", "bottom", "d_route", "top")
arrow("s0b", "bottom", "d_route", "top")

y = adv(190)
rect_node("n_new", 1, y, "→ 明確不同：建立新案", ["review_id 新建，human_state=preparing"], h=80, role=1)
rect_node("n_resume", 2, y, "→ 明確相同：依 checkpoint 復原", ["讀 durable revision，依 human_state 接續到對應步驟"], h=80, role=2, dashed=True, badge="待驗證")
arrow("d_route", "left", "n_new", "top", label="明確不同")
arrow("d_route", "right", "n_resume", "top", label="明確相同")

y = adv(120)
diamond_node("d_user_route", LANE_CX[0], y, "使用者裁決", ["恢復既有 review_id，", "或建立新案？"], w=300, h=140)
arrow("d_route", "bottom", "d_user_route", "top", label="重疊／不確定", waypoints=[(LANE_CX[0], nodes["d_route"]["bottom"][1]+40)])

# manual_recovery_required（側欄共用節點：Step 0 資料矛盾是第一個觸發點，
# Step 3/4 checkpoint 鏈的 R2 之後會再指到同一個節點，見下方）
rec_y1 = y - 10
rect_node("mrr", REC_CX, rec_y1, "manual_recovery_required", [
    "「等待使用者」下的技術警告，不是第六個主要狀態",
    "使用者決定：資料補齊後重跑 status，或視為不可修復"], w=REC_W-20, h=120, role=None, stroke="var(--red)", fill="var(--red-soft)", dashed=True, badge="待驗證")
arrow("d_route", "right", "mrr", "left", label="關鍵歷史缺失／矛盾", dashed=True, color="var(--red)")

y = adv(120)
# loop-back edges from d_user_route back up into route outcomes
arrow("d_user_route", "left", "n_new", "left", label="選建立新案", dashed=True,
      waypoints=[(LANE_CX[0]-70, nodes["d_user_route"]["cy"]), (LANE_CX[0]-70, nodes["n_new"]["cy"]-20), (nodes["n_new"]["left"][0], nodes["n_new"]["cy"]-20)])
arrow("d_user_route", "right", "n_resume", "left", label="選恢復既有", dashed=True,
      waypoints=[(LANE_CX[0]+90, nodes["d_user_route"]["cy"]-30), (nodes["n_resume"]["left"][0]-40, nodes["n_resume"]["cy"]+30), (nodes["n_resume"]["left"][0], nodes["n_resume"]["cy"]+30)])

y = adv(70)
rect_node("s1", 1, y, "Step 1　整理送審內容", [
    "固定覆蓋：問題／結論／限制／關鍵前提查證／",
    "替代方案／未知／排除內容",
    "查證標籤：已查證／可查證未查證／純屬判斷",
    "匿名化：去權威歸屬，保留限制與證據",
    "每次低成本搜尋 .review-collaboration/history"], h=190, role=1)
arrow("n_new", "bottom", "s1", "top")

y = adv(230)
rect_node("s2a", 1, y, "Step 2　兩段式 checklist", [
    "先重建角色／輸入輸出／狀態／交接／外部依賴",
    "再依六面向：目標對齊／完整性／可行性／",
    "安全性／可逆性／成本",
    "固定開放式 ceiling-breaker 指令（不客製）"], h=150, role=1)
arrow("s1", "bottom", "s2a", "top")

y = adv(180)
rect_node("s2b", center_lane=(0,1), cy=y, title="呈現完整送審 package", lines=[
    "使用者確認：已納入／刻意排除／尚未確定",
    "可先看精簡版，但完整內容必須可查閱"], h=100, role=0)
arrow("s2a", "bottom", "s2b", "top")

y = adv(140)
diamond_node("d_confirm", LANE_CX[0], y, "使用者確認完整 package？", w=320, h=150)
arrow("s2b", "bottom", "d_confirm", "top")

y = adv(190)
rect_node("confirm_pkg", 2, y, "confirm-package　安全落地", [
    "暫存寫入 → 依完整 hash atomic rename",
    "→ 讀回驗 hash → expected-revision 原子更新 state",
    "human_state → confirmed-recoverable"], h=140, role=2, badge="恢復起點")
arrow("d_confirm", "bottom", "confirm_pkg", "top", label="確認")
arrow("d_confirm", "left", "s1", "left", label="需修改", dashed=True,
      waypoints=[(LANE_CX[0]-190, nodes["d_confirm"]["cy"]), (LANE_CX[0]-190, nodes["s1"]["cy"]-150), (25, nodes["s1"]["cy"]-150), (25, nodes["s1"]["cy"])])

pill_data("dp_hash", LANE_CX[3]+10, y-70, "package hash（完整 SHA-256）", w=270)
pill_data("dp_state1", LANE_CX[3]+10, y+15, "review-state.json rev++", w=230)
arrow("confirm_pkg", "right", "dp_hash", "left", color="var(--muted)")

y = adv(190)
rect_node("advance1", 1, y, "Producer 呼叫 advance", ["review_id ＋ expected revision"], h=80, role=1)
arrow("confirm_pkg", "bottom", "advance1", "right",
      waypoints=[(LANE_CX[2], y), ])

y = adv(130)
# checkpoint strip in adapter lane
cp_labels = ["prepared", "launch_intent_saved", "thread_captured", "result_validated", "state_committed"]
cp_w = LANE_W - 20
cp_x0 = LANE_CX[2] - cp_w/2
rect_node("cp_strip", 2, y, "Step 3 技術 checkpoint 鏈", [], h=92, role=2, dashed=True, badge="待驗證")
elems.append(fo_text(LANE_CX[2], y+18, cp_w-20, 46, "", [
    '<span style="font-family:Consolas,monospace;font-size:10.6px">' + " → ".join(cp_labels[:3]) + '</span>',
    '<span style="font-family:Consolas,monospace;font-size:10.6px">' + " → ".join(cp_labels[3:]) + '</span>'
]))
arrow("advance1", "bottom", "cp_strip", "top")

# recovery rail R2/R3/R4 anchored beside checkpoint strip
rect_node("r2", REC_CX, y-40, "R：launch intent 已存但啟動與否不明", ["查 PID／events／thread，仍不明才 MRR"], h=80, role=None, stroke="var(--amber)", fill="var(--amber-soft)", dashed=True, w=REC_W-20)
rect_node("r3", REC_CX, y+55, "R：有 thread_id 但無可信結果", ["只 resume 同一 thread，不重送"], h=70, role=None, stroke="var(--amber)", fill="var(--amber-soft)", dashed=True, w=REC_W-20)
arrow("cp_strip", "right", "r2", "left", dashed=True, color="var(--amber)")
arrow("cp_strip", "right", "r3", "left", dashed=True, color="var(--amber)")

y = adv(150)
rect_node("codex_call", 2, y, "adapter 啟動／resume Codex", ["安全順序：驗證 package → 保存 launch intent →", "啟動；看到 thread.started 立即持久化 thread_id"], h=100, role=2)
rect_node("codex_exec", 3, y, "Codex 獨立審查", ["讀取 package＋checklist＋ceiling-breaker", "產生 schema 限定的結構化結果"], h=100, role=3)
arrow("cp_strip", "bottom", "codex_call", "top")
arrow("codex_call", "right", "codex_exec", "left")
pill_data("dp_thread", REC_CX, y, "thread ID（capture 後立即持久化）", w=280)
arrow("codex_call", "right", "dp_thread", "left", color="var(--muted)", waypoints=[(LANE_CX[2]+LANE_W/2+150, y)])

y = adv(140)
rect_node("validate", 2, y, "adapter 驗證結果", ["process／exit code／completion event／", "schema／hash 全部可信才接受"], h=90, role=2, badge="待驗證")
arrow("codex_exec", "bottom", "validate", "right", waypoints=[(LANE_CX[3], y), ])
rect_node("r4", REC_CX, y, "R：result 已驗證但 state 未 commit", ["只做本地冪等 commit，不再呼叫 Codex"], h=80, role=None, stroke="var(--amber)", fill="var(--amber-soft)", dashed=True, w=REC_W-20)
arrow("validate", "right", "r4", "left", dashed=True, color="var(--amber)")

y = adv(120)
rect_node("state_commit", 2, y, "state_committed", ["原子推進 review-state.json；", "human_state 全程維持 reviewing"], h=80, role=2)
arrow("validate", "bottom", "state_commit", "top")
pill_data("dp_receipt", LANE_CX[3]+10, y, "operation receipt（每次呼叫）", w=250)
arrow("state_commit", "right", "dp_receipt", "left", color="var(--muted)")

GAP_C = (LANE_LEFT[2] + LANE_W + LANE_LEFT[3]) / 2       # lane2／lane3 之間的空白走廊，長距離繞行用
GAP_D = (LANE_LEFT[3] + LANE_W + REC_LEFT) / 2            # lane3／側欄之間的空白走廊

y = adv(110)
diamond_node("d_outcome", (LANE_CX[1]+LANE_CX[2])/2, y, "頂層 outcome（schema 限定）", [
    "CONSENSUS／ISSUES_RAISED／", "MATERIAL_REQUIRED"], w=430, h=170)
arrow("state_commit", "bottom", "d_outcome", "right", waypoints=[(LANE_CX[2], y)])

# ---------- MATERIAL_REQUIRED sub-loop ----------
# 刻意放在 lane3（Reviewer 欄，Step3 執行後這裡已空出），避免跟下面 ISSUES_RAISED／
# CONSENSUS 兩條分支共用 lane0-2 的直落線互相穿越。
y_mat = adv(170)
rect_node("mat_req", 3, y_mat, "MATERIAL_REQUIRED", ["append-only material-request-r&lt;N&gt;.json", "非 final attempt，只能同時要求補件"], h=90, role=2, fill="var(--amber-soft)", stroke="var(--amber)")
arrow("d_outcome", "right", "mat_req", "top", label="MATERIAL_REQUIRED", color="var(--amber)",
      waypoints=[(LANE_CX[3], nodes["d_outcome"]["cy"])])
pill_data("dp_matreq", REC_CX, y_mat, "material request（≤3段/案）", w=240)
arrow("mat_req", "right", "dp_matreq", "left", color="var(--muted)")

y_mat = y_mat + 110
rect_node("mat_decide", 3, y_mat, "Producer／使用者一次決定", [
    "提供已整理 excerpt（每案累計最多三段），", "或標記 unavailable —— 這是唯一停點"], h=100, role=0, fill="var(--amber-soft)", stroke="var(--amber)")
arrow("mat_req", "bottom", "mat_decide", "top")

y_mat = y_mat + 130
rect_node("mat_submit", 3, y_mat, "submit 補件 → advance 續同一 round", ["resume 同一 thread；不改 base package；", "不增加 round"], h=90, role=2, fill="var(--amber-soft)", stroke="var(--amber)")
arrow("mat_decide", "bottom", "mat_submit", "top")
arrow("mat_submit", "left", "codex_call", "bottom", label="同 round material loop", dashed=False, color="var(--amber)",
      waypoints=[(GAP_C, y_mat), (GAP_C, nodes["codex_call"]["cy"]+60)], loop=True)

# ---------- ISSUES_RAISED branch ----------
y = adv(190)
rect_node("fixpush", 1, y, "ISSUES_RAISED：Producer 逐 issue 判斷", ["Fix（具體修正文案，不改真實 target）", "或 Pushback（理由＋查證標籤）"], h=100, role=1, fill="var(--red-soft)", stroke="var(--red)")
arrow("d_outcome", "left", "fixpush", "top", label="ISSUES_RAISED", color="var(--red)",
      waypoints=[(LANE_CX[1], nodes["d_outcome"]["cy"]+40)])

y = adv(130)
rect_node("submit_resp", 2, y, "submit Producer response", ["immutable artifact；下一輪呼叫 Codex"], h=80, role=2, fill="var(--red-soft)", stroke="var(--red)")
arrow("fixpush", "bottom", "submit_resp", "left", waypoints=[(LANE_CX[1], y), ])
arrow("submit_resp", "right", "codex_call", "bottom", label="送出下一輪呼叫", color="var(--red)",
      waypoints=[(LANE_CX[2]+130, y), (LANE_CX[2]+130, nodes["codex_call"]["cy"]+90)], loop=True)

y = adv(130)
diamond_node("d_cap", 2, y, "N ＜ cap？", ["完成 final outcome 才計入 round"], w=280, h=140, stroke="var(--red)", fill="var(--red-soft)")
arrow("submit_resp", "bottom", "d_cap", "top")
arrow("d_cap", "left", "advance1", "left", label="N＜cap：下一 final round", dashed=False, color="var(--red)",
      waypoints=[(LANE_CX[1]-150, y), (LANE_CX[1]-150, nodes["advance1"]["cy"])], loop=True)

y = adv(150)
rect_node("wait_arb", 0, y, "N＝cap：waiting-user／arbitration", ["禁止建立 N+1；等使用者仲裁"], h=90, role=0, fill="var(--red-soft)", stroke="var(--red)")
arrow("d_cap", "right", "wait_arb", "top", label="N＝cap", color="var(--red)",
      waypoints=[(LANE_CX[0], nodes["d_cap"]["cy"])])

y = adv(130)
diamond_node("d_arb", LANE_CX[0], y, "使用者仲裁", ["結束（放棄）；", "或新增實質輸入＋提高 cap"], w=300, h=150, stroke="var(--red)", fill="var(--red-soft)")
arrow("wait_arb", "bottom", "d_arb", "top")

y = adv(150)
rect_node("terminate", REC_CX, y, "terminate（abandoned／superseded）", [
    "仍產生自己的 terminal history／completion.json，", "不刪證據；不依賴 CONSENSUS 分支的節點"], w=REC_W-20, h=110, role=None, stroke="var(--red)", fill="var(--red-soft)")
arrow("d_arb", "right", "terminate", "top", label="放棄", color="var(--red)",
      waypoints=[(LANE_CX[0]+180, nodes["d_arb"]["cy"])])
arrow("mrr", "bottom", "terminate", "left", label="視為不可修復", dashed=True, color="var(--red)",
      waypoints=[(GAP_D, nodes["mrr"]["cy"]+70), (GAP_D, nodes["terminate"]["cy"])])
arrow("d_arb", "left", "s1", "left", label="cap 後新增輸入回 Step1-2", dashed=False, color="var(--red)",
      waypoints=[(15, nodes["d_arb"]["cy"]), (15, nodes["s1"]["cy"]+40), (nodes["s1"]["left"][0], nodes["s1"]["cy"]+40)], loop=True)

# ---------- CONSENSUS branch ----------
# 這條分支排在 ISSUES_RAISED 整段（fixpush～terminate）之後，兩者互斥、不會同時發生，
# 但版面上仍會共用 lane0-2；從 d_outcome 直接垂直落下會穿過 ISSUES_RAISED 的節點，
# 所以繞道 GAP_C 走廊（lane2／lane3 之間，這段一路淨空）到 s5a1 的高度才切回 lane1。
y = adv(80)
rect_node("s5a1", 1, y, "CONSENSUS → Step 5a 編譯 final package", ["最終決策／已收斂 Fix／未解風險／", "證據／各 issue 處置"], h=100, role=1, fill="var(--green-soft)", stroke="var(--green)")
arrow("d_outcome", "right", "s5a1", "left", label="CONSENSUS", color="var(--green)",
      waypoints=[(GAP_C, nodes["fixpush"]["cy"]), (GAP_C, y)])
pill_data("dp_final", LANE_CX[3]+10, y, "final package（完整 SHA-256）", w=260)
arrow("s5a1", "right", "dp_final", "left", color="var(--muted)")
pill_data("dp_ledger", LANE_CX[3]+10, y-70, "ledger snapshot（每個 completed round）", w=290)

y = adv(140)
diamond_node("d_approve", LANE_CX[0], y, "使用者核准（綁定 exact hash）？", w=320, h=150, stroke="var(--green)", fill="var(--green-soft)")
arrow("s5a1", "bottom", "d_approve", "top", waypoints=[(LANE_CX[0], y-70), ])

y = adv(190)
rect_node("handoff", 2, y, "產生 handoff ＋ target baseline", ["review_id／final_package_hash／結論／Fix／", "target scope／constraints／follow_up_*"], h=110, role=2, fill="var(--green-soft)", stroke="var(--green)")
arrow("d_approve", "bottom", "handoff", "top", label="核准")
pill_data("dp_handoff", LANE_CX[3]+10, y, "handoff packet", w=170)
arrow("handoff", "right", "dp_handoff", "left", color="var(--muted)")

arrow("d_approve", "left", "s5a1", "left", label="僅重排：重新 hash 再確認", dashed=True, color="var(--green)",
      waypoints=[(LANE_CX[0]-180, y-260), (LANE_CX[0]-180, nodes["s5a1"]["cy"]+40), (nodes["s5a1"]["left"][0], nodes["s5a1"]["cy"]+40)])
arrow("d_approve", "left", "s1", "left", label="改動主張：回 Step1-2＋提高 cap", dashed=True, color="var(--green)",
      waypoints=[(5, nodes["d_approve"]["cy"]), (5, nodes["s1"]["cy"]+70), (nodes["s1"]["left"][0], nodes["s1"]["cy"]+70)])

y = adv(170)
rect_node("history", 2, y, "保存 history bundle", ["實體複製 final package／handoff／ledger", "所傳遞引用的所有 immutable artifact"], h=90, role=2, fill="var(--green-soft)", stroke="var(--green)")
arrow("handoff", "bottom", "history", "top")
pill_data("dp_history", LANE_CX[3]+10, y, "history bundle", w=170)
arrow("history", "right", "dp_history", "left", color="var(--muted)")

y = adv(140)
rect_node("completion", 2, y, "驗證必要 hash → 寫入 completion.json", ["ended 的唯一權威證據"], h=90, role=2, fill="var(--green-soft)", stroke="var(--green)", badge="待驗證")
arrow("history", "bottom", "completion", "top")
pill_data("dp_completion", LANE_CX[3]+10, y, "completion.json", w=180)
arrow("completion", "right", "dp_completion", "left", color="var(--muted)")
rect_node("r5", REC_CX, y-95, "R：history 部分寫入，marker 未生效", ["冪等補齊並驗 hash，不得標 ended", "或先刪 active"], h=90, role=None, stroke="var(--amber)", fill="var(--amber-soft)", dashed=True, w=REC_W-20)
arrow("completion", "right", "r5", "left", dashed=True, color="var(--amber)")

y = adv(140)
rect_node("optional", 2, y, "best effort：選配 review-log／ADR、清理 active／TEMP", ["失敗只留 warning，不反轉核心結案"], h=80, role=2, dashed=True, fill="var(--surface-2)", badge="選配")
arrow("completion", "bottom", "optional", "top")

y = adv(120)
rect_node("end", center_lane=(0,3), cy=y, title="human_state = ended", lines=[
    "consensus-finalized／user-arbitrated-closed／abandoned／superseded"], h=80, role=None, stroke="var(--green)", fill="var(--green-soft)")
arrow("optional", "bottom", "end", "top", waypoints=[(LANE_CX[2], y), ])
arrow("terminate", "bottom", "end", "right", label="同樣驗 hash→completion.json→best effort 清理", dashed=True, color="var(--red)",
      waypoints=[(GAP_D, nodes["terminate"]["cy"]+90), (GAP_D, y)])

TOTAL_H = y + 100

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

svg = f'<svg viewBox="0 0 {TOTAL_W:.0f} {TOTAL_H:.0f}" xmlns="http://www.w3.org/2000/svg" font-family="Microsoft JhengHei,PingFang TC,Noto Sans TC,sans-serif">'
svg += svg_defs
svg += "".join(edge_elems)
svg += "".join(elems)
svg += "</svg>"

with open("flow-diagram.svg", "w", encoding="utf-8") as f:
    f.write(f'<?xml version="1.0" encoding="UTF-8"?>\n{svg}')

with open("flow-diagram.embed.svg", "w", encoding="utf-8") as f:
    f.write(svg)

print(f"width={TOTAL_W:.0f} height={TOTAL_H:.0f}")
print(f"nodes={len(nodes)} edges={len(edge_elems)}")
