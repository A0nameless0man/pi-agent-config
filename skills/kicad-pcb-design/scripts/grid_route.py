#!/usr/bin/env python
"""grid_route.py — KiCad 9 PCB 两层网格自动布线(手动布线路径的脚本化)。

用法(KiCad 自带 python):
  "C:/Program Files/KiCad/9.0/bin/python.exe" grid_route.py <board.kicad_pcb> [--grid 0.25] [--signal-w 0.25] [--power-w 0.5]

算法: 对每个未布通的 net 取 pad 集 → Prim 最小生成树得到待连 pad 对 →
两层(F.Cu/B.Cu)网格 A* 搜索。障碍格记录占用 net 的 code, 本 net 格自由通行,
其他 net 的 pad 障碍区外扩; 换层付过孔代价并在换层点生成 PCB_VIA。
电源类 net(GND/+V)先布且用加宽线。

输出: 布线统计 + 未布通 net 清单(留人工/Freerouting 处理)。
"""
import argparse
import heapq
import math

import pcbnew

POWER_HINTS = ("GND", "+5V", "+3V3", "VCC", "+12V", "VBUS")


def mm(v):
    return pcbnew.FromMM(v)


class Grid:
    def __init__(self, w, h, step):
        self.step = step
        self.nx = int(math.ceil(w / step)) + 1
        self.ny = int(math.ceil(h / step)) + 1
        # pad_owner[layer][ix][iy] = 实心 pad 区 netcode(0 = 无)
        # pad_keepout[layer][ix][iy] = set(netcode): margin 区覆盖到的 pad 集合(他 net 禁入)
        self.pad_owner = [[[0] * self.ny for _ in range(self.nx)] for _ in range(2)]
        self.pad_keepout = [[[set() for _ in range(self.ny)] for _ in range(self.nx)] for _ in range(2)]
        self.trace = [[[0] * self.ny for _ in range(self.nx)] for _ in range(2)]

    def idx(self, x_mm, y_mm):
        return int(round(x_mm / self.step)), int(round(y_mm / self.step))

    def mark_pad_solid(self, x_mm, y_mm, netcode, sx_mm, sy_mm):
        """实心 pad 区: 记录 owner(本 net 走线端点可达)"""
        ix0, iy0 = self.idx(x_mm - sx_mm / 2, y_mm - sy_mm / 2)
        ix1, iy1 = self.idx(x_mm + sx_mm / 2, y_mm + sy_mm / 2)
        for layer in (0, 1):
            for lx in range(max(0, ix0), min(self.nx, ix1 + 1)):
                row = self.pad_owner[layer][lx]
                for ly in range(max(0, iy0), min(self.ny, iy1 + 1)):
                    row[ly] = netcode

    def mark_pad_keepout(self, x_mm, y_mm, netcode, sx_mm, sy_mm, margin_mm):
        """margin 区: 记录 netcode 到 keepout 集合(他 net 禁入)"""
        ix0, iy0 = self.idx(x_mm - sx_mm / 2 - margin_mm, y_mm - sy_mm / 2 - margin_mm)
        ix1, iy1 = self.idx(x_mm + sx_mm / 2 + margin_mm, y_mm + sy_mm / 2 + margin_mm)
        for layer in (0, 1):
            for lx in range(max(0, ix0), min(self.nx, ix1 + 1)):
                for ly in range(max(0, iy0), min(self.ny, iy1 + 1)):
                    self.pad_keepout[layer][lx][ly].add(netcode)

    def via_clear(self, net, ix, iy, r):
        """过孔净空: (2r+1)^2 区域内无其他 net 的 keepout/trace"""
        for layer in (0, 1):
            for lx in range(ix - r, ix + r + 1):
                for ly in range(iy - r, iy + r + 1):
                    if not self.in_bounds(lx, ly):
                        return False
                    if any(c != net for c in self.pad_keepout[layer][lx][ly]):
                        return False
                    if self.trace[layer][lx][ly] not in (0, net):
                        return False
        return True

    def near_trace(self, net, layer, ix, iy, r):
        """(2r+1)^2 内是否存在其他 net 的走线中心(间距约束)"""
        for lx in range(ix - r, ix + r + 1):
            for ly in range(iy - r, iy + r + 1):
                if self.in_bounds(lx, ly):
                    own = self.trace[layer][lx][ly]
                    if own != 0 and own != net:
                        return True
        return False

    def in_bounds(self, ix, iy):
        return 0 <= ix < self.nx and 0 <= iy < self.ny

    def walkable(self, net, layer, ix, iy):
        if not self.in_bounds(ix, iy):
            return False
        if any(c != net for c in self.pad_keepout[layer][ix][iy]):
            return False
        own = self.trace[layer][ix][iy]
        return own == 0 or own == net


def astar(g, net, free, src, dst, via_cost):
    """src/dst: (ix,iy); free=True 允许换层(起始 F.Cu), False 只走 start_layer。
    返回 [(layer, ix, iy), ...] 或 None"""
    start_layer = 0 if free else src[2]
    pq = []
    best = {}
    start = (start_layer, src[0], src[1])
    heapq.heappush(pq, (0, start))
    best[start] = 0
    parent = {}
    goal = None
    while pq:
        f, cur = heapq.heappop(pq)
        if cur[1] == dst[0] and cur[2] == dst[1]:
            goal = cur
            break
        layer, ix, iy = cur
        moves = []
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx_, ny_ = ix + dx, iy + dy
            if g.walkable(net, layer, nx_, ny_) and not g.near_trace(net, layer, nx_, ny_, 3):
                moves.append((layer, nx_, ny_))
        if free:
            other = 1 - layer
            if g.walkable(net, other, ix, iy) and g.via_clear(net, ix, iy, 3):
                moves.append((other, ix, iy))
        for nxt in moves:
            step_cost = via_cost if nxt[0] != layer else 1
            ng = best[cur] + step_cost
            if ng < best.get(nxt, 1 << 30):
                best[nxt] = ng
                parent[nxt] = cur
                hx = ng + (abs(nxt[1] - dst[0]) + abs(nxt[2] - dst[1]))
                heapq.heappush(pq, (hx, nxt))
    if goal is None:
        return None
    path = [goal]
    while path[-1] in parent:
        path.append(parent[path[-1]])
    path.reverse()
    return path


def mst_edges(pads):
    """pads: [(x,y)] mm → Prim MST 边列表 [(p1, p2)]"""
    if len(pads) <= 1:
        return []
    n = len(pads)
    edges = []
    in_tree = [0]
    rest = list(range(1, n))
    while rest:
        best = None
        for a in in_tree:
            for b in rest:
                d = (pads[a][0] - pads[b][0]) ** 2 + (pads[a][1] - pads[b][1]) ** 2
                if best is None or d < best[0]:
                    best = (d, a, b)
        _, a, b = best
        edges.append((pads[a], pads[b]))
        in_tree.append(b)
        rest.remove(b)
    return edges


def path_to_tracks(path, g, width_mm, netcode, board):
    """格点路径 → 合并直线段 TRACK; 换层处生成 VIA。返回 via 数"""
    vias = 0
    if len(path) < 2:
        return 0

    def pt(node):
        return (node[1] * g.step, node[2] * g.step)

    for node in path:
        L, nx_, ny_ = node
        g.trace[L][nx_][ny_] = netcode

    # 切分段: 每段同层连续
    segs = []
    seg = [path[0]]
    for prev, cur in zip(path, path[1:]):
        if cur[0] != prev[0]:
            segs.append(seg)
            seg = [cur]
        else:
            seg.append(cur)
    segs.append(seg)
    for seg in segs:
        if len(seg) < 2:
            continue
        layer = seg[0][0]
        pts = [pt(n) for n in seg]
        merged = [pts[0]]
        for p in pts[1:]:
            if len(merged) >= 2:
                (x1, y1), (x2, y2) = merged[-2], merged[-1]
                if (x2 - x1) * (p[1] - y2) == (y2 - y1) * (p[0] - x2):
                    merged[-1] = p
                    continue
            merged.append(p)
        for (x1, y1), (x2, y2) in zip(merged, merged[1:]):
            if abs(x1 - x2) + abs(y1 - y2) < 1e-9:
                continue
            t = pcbnew.PCB_TRACK(board)
            t.SetStart(pcbnew.VECTOR2I(mm(x1), mm(y1)))
            t.SetEnd(pcbnew.VECTOR2I(mm(x2), mm(y2)))
            t.SetWidth(mm(width_mm))
            t.SetLayer(pcbnew.F_Cu if layer == 0 else pcbnew.B_Cu)
            t.SetNetCode(netcode)
            board.Add(t)
    for a, b in zip(path, path[1:]):
        if a[0] != b[0]:
            v = pcbnew.PCB_VIA(board)
            v.SetPosition(pcbnew.VECTOR2I(mm(a[1] * g.step), mm(a[2] * g.step)))
            v.SetViaType(pcbnew.VIATYPE_THROUGH)
            v.SetDrill(mm(0.4))
            v.SetFrontWidth(mm(0.8))
            v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
            v.SetNetCode(netcode)
            board.Add(v)
            vias += 1
    return vias


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pcb")
    ap.add_argument("--grid", type=float, default=0.25)
    ap.add_argument("--signal-w", type=float, default=0.25)
    ap.add_argument("--power-w", type=float, default=0.5)
    ap.add_argument("--pad-clearance", type=float, default=0.15, help="其他 net pad 的障碍外扩半径 mm")
    a = ap.parse_args()

    b = pcbnew.LoadBoard(a.pcb)
    bb = b.GetBoardEdgesBoundingBox()
    w, h = pcbnew.ToMM(bb.GetWidth()), pcbnew.ToMM(bb.GetHeight())
    g = Grid(max(w, 1), max(h, 1), a.grid)

    net_pads = {}  # netcode -> [(x_mm, y_mm)]
    pad_sizes = {}  # (x, y) -> (sx, sy) mm
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            pos = pad.GetPosition()
            x, y = pcbnew.ToMM(pos.x), pcbnew.ToMM(pos.y)
            net_pads.setdefault(pad.GetNetCode(), []).append((x, y))
            pad_sizes[(x, y)] = (pcbnew.ToMM(pad.GetSizeX()), pcbnew.ToMM(pad.GetSizeY()))
    netnames = {n.GetNetCode(): n.GetNetname() for n in b.GetNetsByName().values() if n.GetNetCode() > 0}
    # pad 矩形障碍: 外扩 = clearance 0.2 + 线半宽 0.125
    margin = 0.2 + a.power_w / 2 + a.grid / 2  # 按最宽线算 + 网格吸附误差补偿
    for fp in b.GetFootprints():
        for pad in fp.Pads():
            pos = pad.GetPosition()
            x, y = pcbnew.ToMM(pos.x), pcbnew.ToMM(pos.y)
            nc = pad.GetNetCode()
            owner = nc if nc > 0 else -1  # 无 net pad(NC/机械) = 全局死区
            sx, sy = pad_sizes[(x, y)]
            g.mark_pad_solid(x, y, owner, sx, sy)
            g.mark_pad_keepout(x, y, owner, sx, sy, margin)

    # 板缘禁区: copper edge clearance 0.3 + 最宽线半宽 0.25 + 吸附余量 0.125
    edge = 0.3 + a.power_w / 2 + a.grid / 2
    ex0, ex1 = g.idx(edge, 0)[0], g.idx(w - edge, 0)[0]
    ey0, ey1 = g.idx(0, edge)[1], g.idx(0, h - edge)[1]
    for layer in (0, 1):
        for lx in range(g.nx):
            for ly in range(g.ny):
                if lx < ex0 or lx > ex1 or ly < ey0 or ly > ey1:
                    g.pad_keepout[layer][lx][ly].add(-1)
    order = sorted(net_pads.keys(),
                   key=lambda nc: (0 if any(h in netnames.get(nc, "").upper() for h in POWER_HINTS) else 1, nc))
    routed, failed, total_vias = 0, [], 0
    for nc in order:
        pads = net_pads[nc]
        if len(pads) < 2 or nc <= 0:
            continue
        name = netnames.get(nc, "")
        width = a.power_w if any(h in name.upper() for h in POWER_HINTS) else a.signal_w
        # 并查集: 段失败但两端已通过其他路径连通则不算失败
        parent = list(range(len(pads)))
        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a
        ok_all = True
        for (p1, p2) in mst_edges(pads):
            ia, ib = pads.index(p1), pads.index(p2)
            if find(ia) == find(ib):
                continue
            s = g.idx(*p1) + (0,)
            d = g.idx(*p2) + (0,)
            path = astar(g, nc, True, (s[0], s[1]), (d[0], d[1]), 12)
            if path is None:
                ok_all = False
                failed.append((name, p1, p2))
                continue
            total_vias += path_to_tracks(path, g, width, nc, b)
            parent[find(ia)] = find(ib)
        if ok_all:
            routed += 1
    pcbnew.SaveBoard(a.pcb, b)
    print(f"routed nets: {routed}/{len([n for n in order if len(net_pads[n])>1])}, vias: {total_vias}, failed segments: {len(failed)}")
    for (name, p1, p2) in failed[:20]:
        print(f"  FAILED {name}: {p1} -> {p2}")


if __name__ == "__main__":
    main()
