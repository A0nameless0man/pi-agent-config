#!/usr/bin/env python
"""板级铺铜:add_pours.py <board.kicad_pcb> [--gnd-layer B] [--vcc-layer F] [--edge-gap 0.25]

- GND 整板 pour(--gnd-layer 指定层,默认 B.Cu;不指定 none 跳过)
- VCC/电源整板 pour(--vcc-layer 默认 F.Cu;仅当 net 表里存在 +5V 类电源 net)
- 参数源自 KiCad 9 pcbnew 实测 + 板厂能力:thermal gap/spoke 0.3、clearance 0.3、min thickness 0.25、
  outline 内缩 0.25(贴 edge clearance 0.3 需求)
- 填充用 ZONE_FILLER(board).Fill([zones])(KiCad 9 签名;构造时绑 board)
- 坐标单位:python API 全程 internal nm(FromMM 转换)
"""
import argparse

import pcbnew


def find_net(board, name):
    for n in board.GetNetsByName().values():
        if n.GetNetname() == name:
            return n.GetNetCode()
    return 0


def make_pour(board, layer, netcode, edge_gap_mm, solid=False):
    # 幂等: 同层同 net 的 zone 已存在则复用(多次运行不重复堆 zone), 连接参数按最新策略刷新
    for z in board.Zones():
        if z.GetLayer() == layer and (z.GetNetCode() or 0) == (netcode or 0):
            z.SetPadConnection(
                pcbnew.ZONE_CONNECTION_FULL if solid else pcbnew.ZONE_CONNECTION_THERMAL)
            return z
    bb = board.GetBoardEdgesBoundingBox()
    m = pcbnew.FromMM(edge_gap_mm)
    x0, y0 = bb.GetLeft() + m, bb.GetTop() + m
    x1, y1 = bb.GetRight() - m, bb.GetBottom() - m
    zone = pcbnew.ZONE(board)
    zone.SetLayer(layer)
    if netcode:
        zone.SetNetCode(netcode)
    ol = zone.Outline()
    ol.NewOutline()
    for pt in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        ol.Append(*pt)
    # 电源 pour 用 solid 连接(避免 thermal 辐条被邻近走线挤占导致 starved_thermal);
    # GND 用 thermal(手焊友好)
    zone.SetPadConnection(
        pcbnew.ZONE_CONNECTION_FULL if solid else pcbnew.ZONE_CONNECTION_THERMAL)
    zone.SetMinThickness(pcbnew.FromMM(0.25))
    zone.SetLocalClearance(pcbnew.FromMM(0.3))
    zone.SetThermalReliefGap(pcbnew.FromMM(0.3))
    zone.SetThermalReliefSpokeWidth(pcbnew.FromMM(0.5))  # JLC 要求 >0.25mm, 0.5 留裕量
    zone.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    board.Add(zone)
    return zone


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("board")
    ap.add_argument("--gnd-layer", default="B.Cu")
    ap.add_argument("--vcc-layer", default="F.Cu")
    ap.add_argument("--edge-gap", type=float, default=0.25)
    args = ap.parse_args()

    board = pcbnew.LoadBoard(args.board)
    layer_of = {"F.Cu": pcbnew.F_Cu, "B.Cu": pcbnew.B_Cu}
    zones = []

    gnd = find_net(board, "GND")
    if args.gnd_layer != "none" and gnd:
        zones.append(make_pour(board, layer_of[args.gnd_layer], gnd, args.edge_gap))
        print("GND pour on", args.gnd_layer)

    vcc = find_net(board, "+5V") or find_net(board, "VCC") or find_net(board, "+3V3")
    if args.vcc_layer != "none" and vcc:
        zones.append(make_pour(board, layer_of[args.vcc_layer], vcc, args.edge_gap, solid=True))
        print("VCC pour on", args.vcc_layer, "(solid)")

    if not zones:
        print("no net to pour (GND/VCC not found or layers=none)")
        return
    filler = pcbnew.ZONE_FILLER(board)
    ok = filler.Fill(zones)
    print("fill ok:", ok)
    pcbnew.SaveBoard(args.board, board)
    print("saved")


if __name__ == "__main__":
    main()
