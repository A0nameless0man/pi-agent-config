#!/usr/bin/env python
"""build_board.py — 从 netlist JSON spec 生成 KiCad 9 原理图与 PCB 骨架。

单一事实源 = spec.json:
  {
    "name": "led_blinker",
    "parts": [
      {"ref": "U1", "sym": "74xx:74LS161", "value": "74LS161",
       "fp": "Package_SO:SOIC-16_3.9x9.9mm_P1.27mm", "at": [40.0, 30.0], "rot": 0}
    ],
    "nets": {"CLK": [["U1","2"], ["U2","3"]]},
    "board": {"w": 80, "h": 50}
  }

输出: <outdir>/<name>.kicad_sch(符号+每 pin 引线+网络标签, ERC 可跑)
      <outdir>/<name>.kicad_pcb(pcbnew API 建: 板框/网络/footprint 放置+pad 赋 net)

用法: 必须用 KiCad 自带 python(需要 pcbnew 模块):
  Windows: "C:/Program Files/KiCad/9.0/bin/python.exe" build_board.py spec.json outdir
  库搜索路径: --kicad-dir 默认 C:/Program Files/KiCad/9.0, 或环境变量 KICAD_DIR
约定: spec 中坐标单位 mm, 原点左上; 本脚本生成的符号实例全部 rot=0 时已验证,
      非 0 旋转用 KiCad RotatePoint 公式, 首次使用请先小样验证。
"""
import argparse
import json
import math
import os
import re
import sys
import uuid

KICAD_DIR = os.environ.get("KICAD_DIR", r"C:/Program Files/KiCad/9.0")
SYM_DIR = os.path.join(KICAD_DIR, "share", "kicad", "symbols")
FP_DIR = os.path.join(KICAD_DIR, "share", "kicad", "footprints")

# KiCad 9 交付的确定性别名(库名曾改名/拆分, 查无此库时回退)
LIB_ALIASES = {"CMOS_4000": "4xxx"}


def det_uuid(*seed: str) -> str:
    """确定性 UUID(同 spec 重跑产物稳定, git diff 友好)"""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "kicad-skill-e2e:" + ":".join(seed)))


def extract_symbol_block(lib_path: str, sym_name: str) -> str:
    """从 .kicad_sym 提取顶层符号定义文本块(括号配平)"""
    src = open(lib_path, encoding="utf-8").read()
    marker = '(symbol "%s"' % sym_name
    i = src.find(marker)
    if i < 0:
        raise KeyError(f"symbol {sym_name} not found in {lib_path}")
    # 回退到行首对齐的 (symbol
    depth = 0
    j = i
    while j < len(src):
        c = src[j]
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return src[i:j + 1]
        j += 1
    raise ValueError(f"unbalanced s-expr for {sym_name} in {lib_path}")


def find_symbol_lib(lib_id: str) -> str:
    lib = lib_id.split(":")[0] if ":" in lib_id else lib_id
    lib = LIB_ALIASES.get(lib, lib)
    p = os.path.join(SYM_DIR, lib + ".kicad_sym")
    if not os.path.isfile(p):
        raise FileNotFoundError(f"symbol lib not found: {p}")
    return p


def parse_pins(symbol_block: str):
    """返回 [(number, x, y, angle)] — pin 连接点库坐标(mm)"""
    pins = []
    for m in re.finditer(
        r'\(pin\s+(\w+)\s+\w+\s*\(at\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\)\s*\(length\s+([\d.]+)\)'
        r'.*?\(number\s+"([^"]*)"', symbol_block, re.S):
        etype, x, y, a, ln, num = m.groups()
        pins.append((num, float(x), float(y), float(a)))
    return pins


def rot_point(px: float, py: float, deg: float):
    """库坐标系(y 向上)逆时针旋转 deg 度; 调用方负责随后的画布 y 翻转"""
    r = math.radians(deg)
    return px * math.cos(r) - py * math.sin(r), px * math.sin(r) + py * math.cos(r)


def sch_symbol_instances(spec: dict, lib_blocks: dict, sheet_uuid: str):
    """生成符号实例 + 每 pin 引线 + label 文本"""
    out, wires, labels = [], [], []
    for part in spec["parts"]:
        ref, lib_id = part["ref"], part["sym"]
        lib, name = lib_id.split(":", 1)
        sx, sy = part.get("sch_at", part["at"])
        srot = float(part.get("rot", 0))
        block = lib_blocks[lib_id]
        # pin 连接点全局坐标(mm, sch y 向下)
        pin_pts = {}
        for num, px, py, pa in parse_pins(block):
            rx, ry = rot_point(px, py, srot) if srot else (px, py)
            gx, gy = sx + rx, sy - ry  # 画布 y 向下: 库 y 取反
            pa2 = pa + srot
            # 自由端方向: a=0 → 左(-x), 90 → 下(+y): dir = (-cos a, sin a)
            a_rad = math.radians(pa2)
            dx, dy = -math.cos(a_rad), math.sin(a_rad)  # 库角 a 在画布的引出方向(y 已在连接点翻转)
            ex, ey = gx + 2.54 * dx, gy + 2.54 * dy
            pin_pts[num] = (gx, gy, ex, ey)
            wires.append(f'\t(wire (pts (xy {gx:.4f} {gy:.4f}) (xy {ex:.4f} {ey:.4f}))\n'
                         f'\t\t(stroke (width 0) (type default)) (uuid "{det_uuid(spec["name"], ref, "w", num)}"))\n')
        # pin → net 标签
        for netname, members in spec["nets"].items():
            for mref, mnum in members:
                if mref == ref and mnum in pin_pts:
                    _, _, ex, ey = pin_pts[mnum]
                    labels.append(f'\t(label "{netname}" (at {ex:.4f} {ey:.4f} 0)\n'
                                  f'\t\t(effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "{det_uuid(spec["name"], ref, "l", mnum, netname)}"))\n')
        val = part["value"]
        out.append(f'''\t(symbol
\t\t(lib_id "{name}")
\t\t(at {sx:.4f} {sy:.4f} {int(srot)})
\t\t(unit 1)
\t\t(exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
\t\t(uuid "{det_uuid(spec["name"], ref, "sym")}")
\t\t(property "Reference" "{ref}" (at {sx:.4f} {sy - 5:.4f} 0)
\t\t\t(effects (font (size 1.27 1.27))))
\t\t(property "Value" "{val}" (at {sx:.4f} {sy + 5:.4f} 0)
\t\t\t(effects (font (size 1.27 1.27))))
\t\t(property "Footprint" "{part["fp"]}" (at {sx:.4f} {sy:.4f} 0)
\t\t\t(effects (font (size 1.27 1.27)) (hide yes)))
		(property "Datasheet" "" (at {sx:.4f} {sy:.4f} 0)
			(effects (font (size 1.27 1.27)) (hide yes)))
		(property "Description" "" (at {sx:.4f} {sy:.4f} 0)
			(effects (font (size 1.27 1.27)) (hide yes)))
\t\t(instances
\t\t\t(project "{spec["name"]}" (path "/{sheet_uuid}" (reference "{ref}") (unit 1))))
\t)
''')
    # NC 标志: 在悬空 pin 连接点画 X(KiCad ERC 认可的"有意悬空")
    for nref, nnum in spec.get("nc", []):
        part = next(x for x in spec["parts"] if x["ref"] == nref)
        blk = lib_blocks.get(part["sym"])
        if blk is None:
            continue
        sx, sy = part.get("sch_at", part["at"])
        for num, px, py, pa in parse_pins(blk):
            if num == nnum:
                gx, gy = sx + px, sy - py
                wires.append('\t(no_connect (at %.4f %.4f) (uuid "%s"))\n' % (gx, gy, det_uuid(spec["name"], nref, "nc", nnum)))
                break
    # PWR_FLAG: 为电源 label 提供驱动源(挂在该 net 任一 label 的延长位置)
    for flag_net in spec.get("pwr_flags", []):
        pos = None
        for part in spec["parts"]:
            blk = lib_blocks.get(part["sym"])
            sx, sy = part.get("sch_at", part["at"])
            for num, px, py, pa in parse_pins(blk):
                hit = any(mref == part["ref"] and mnum == num for mref, mnum in spec["nets"].get(flag_net, []))
                if hit:
                    a_rad = math.radians(pa)
                    gx, gy = sx + px, sy - py
                    pos = (gx + 2.54 * (-math.cos(a_rad)), gy + 2.54 * math.sin(a_rad))
                    break
            if pos:
                break
        if pos:
            fx, fy = pos[0] + 2.54, pos[1]
            labels.append('\t(label "%s" (at %.4f %.4f 0)\n\t\t(effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "%s"))\n'
                          % (flag_net, fx, fy, det_uuid(spec["name"], "pwr", flag_net)))
            wires.append('\t(wire (pts (xy %.4f %.4f) (xy %.4f %.4f))\n\t\t(stroke (width 0) (type default)) (uuid "%s"))\n'
                         % (pos[0], pos[1], fx, fy, det_uuid(spec["name"], "pwrw", flag_net)))
            sym_x, sym_y = fx, fy
            out.append(('\t(symbol\n'
                '\t\t(lib_id "PWR_FLAG")\n'
                '\t\t(at %f %f 0)\n'
                '\t\t(unit 1)\n'
                '\t\t(exclude_from_sim no) (in_bom no) (on_board yes) (dnp no)\n'
                '\t\t(uuid "%s")\n'
                '\t\t(property "Reference" "#FLG" (at %f %f 0)\n'
                '\t\t\t(effects (font (size 1.27 1.27)) (hide yes)))\n'
                '\t\t(property "Value" "PWR_FLAG" (at %f %f 0)\n'
                '\t\t\t(effects (font (size 1.27 1.27)) (hide yes)))\n'
                '\t\t(property "Footprint" "" (at %f %f 0)\n'
                '\t\t\t(effects (font (size 1.27 1.27)) (hide yes)))\n'
                '\t\t(property "Datasheet" "~" (at %f %f 0)\n'
                '\t\t\t(effects (font (size 1.27 1.27)) (hide yes)))\n'
                '\t\t(property "Description" "Power symbol creates a global label with name PWR_FLAG" (at %f %f 0)\n'
                '\t\t\t(effects (font (size 1.27 1.27)) (hide yes)))\n'
                '\t\t(instances\n'
                '\t\t\t(project "%s" (path "/%s" (reference "#FLG1") (unit 1))))\n'
                '\t)\n') % (sym_x, sym_y, det_uuid(spec["name"], "pwr", "sym", flag_net),
                     sym_x, sym_y + 3, sym_x, sym_y - 3, sym_x, sym_y, sym_x, sym_y, sym_x, sym_y,
                     spec["name"], sheet_uuid))
    return "".join(out), "".join(wires), "".join(labels)


def build_sch(spec: dict, outdir: str, lib_blocks: dict):
    name = spec["name"]
    root_uuid = det_uuid(name, "root")
    sheet_uuid = root_uuid  # 实例 path 必须引用文件顶层 uuid, 否则符号不归属任何 sheet
    inst, wires, labels = sch_symbol_instances(spec, lib_blocks, sheet_uuid)
    # KiCad 9 实测(sch 解析器): lib_symbols 顶层符号名用库原名(无前缀),
    # 实例 lib_id 同样用无前缀名; 带冒号前缀的块会被拒绝。符号块须含完整
    # 5 property(Reference/Value/Footprint/Datasheet/Description), 缺则整文件加载失败。
    lib_syms = "\n".join(
        '\t\t' + b.replace("\n", "\n\t\t").rstrip() for b in lib_blocks.values())
    text = f'''(kicad_sch
\t(version 20250114)
\t(generator "eeschema")
\t(generator_version "9.0")
\t(uuid "{root_uuid}")
\t(paper "A4")
\t(title_block (title "{name}") (date "2026-09-03"))
\t(lib_symbols
{lib_syms}
\t)
{wires}{labels}{inst}\t(sheet_instances
\t\t(path "/" (page "1"))
\t)
\t(embedded_fonts no)
)
'''
    path = os.path.join(outdir, name + ".kicad_sch")
    open(path, "w", encoding="utf-8").write(text)
    return path


def build_pcb(spec: dict, outdir: str):
    import pcbnew
    mm_ = lambda v: pcbnew.FromMM(v)
    name, w, h = spec["name"], float(spec["board"]["w"]), float(spec["board"]["h"])
    path = os.path.join(outdir, name + ".kicad_pcb")
    b = pcbnew.NewBoard(path)
    b.SetCopperLayerCount(2)
    # 声明制造能力(JLC 经济板量级): DRC 按此规则而非 KiCad 内置默认
    ds = b.GetDesignSettings()
    ds.m_TrackMinWidth = mm_(0.2)
    ds.m_ViasMinSize = mm_(0.8)
    ds.m_ViasMinAnnularWidth = mm_(0.2)
    ds.m_MinClearance = mm_(0.2)
    ds.m_HoleClearance = mm_(0.3)
    # 默认 netclass 过孔尺寸 = Freerouting DSN padstack 的 via 规格(否则 FR 用 0.6/0.3 违反声明规则)
    ds.m_NetSettings.GetDefaultNetclass().SetViaDiameter(mm_(0.8))
    ds.m_NetSettings.GetDefaultNetclass().SetViaDrill(mm_(0.4))
    ds.m_HoleToHoleMin = mm_(0.3)
    ds.m_CopperEdgeClearance = mm_(0.3)
    # 板框矩形 Edge.Cuts (0,0)-(w,h)
    pts = [(0, 0), (w, 0), (w, h), (0, h), (0, 0)]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        e = pcbnew.PCB_SHAPE(b)
        e.SetShape(pcbnew.SHAPE_T_SEGMENT)
        e.SetStart(pcbnew.VECTOR2I(pcbnew.FromMM(x1), pcbnew.FromMM(y1)))
        e.SetEnd(pcbnew.VECTOR2I(pcbnew.FromMM(x2), pcbnew.FromMM(y2)))
        e.SetLayer(pcbnew.Edge_Cuts)
        b.Add(e)
    # 网络注册
    nets = {}
    for i, netname in enumerate([""] + sorted(spec["nets"]), start=1):
        ni = pcbnew.NETINFO_ITEM(b, netname, i)
        b.Add(ni)
        nets[netname] = ni
    nets[""] = b.FindNet(0)
    # footprint 放置 + pad 赋 net
    for part in spec["parts"]:
        lib, fpname = part["fp"].split(":", 1)
        libpath = os.path.join(FP_DIR, lib + ".pretty")
        f = pcbnew.FootprintLoad(libpath, fpname)
        if f is None:
            # 项目级 pretty 回退: <outdir>/lib/<lib>.pretty
            alt = os.path.join(outdir, "lib", lib + ".pretty")
            f = pcbnew.FootprintLoad(alt, fpname)
        if f is None:
            raise FileNotFoundError(f"footprint {part['fp']} not in {libpath}")
        x, y = part["at"]
        f.SetPosition(pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y)))
        f.SetOrientationDegrees(float(part.get("rot", 0)))
        f.SetReference(part["ref"])
        f.SetValue(part["value"])
        b.Add(f)
        pin2net = {}
        for netname, members in spec["nets"].items():
            for mref, mnum in members:
                if mref == part["ref"]:
                    pin2net[mnum] = nets[netname]
        for pad in f.Pads():
            ni = pin2net.get(pad.GetNumber())
            if ni is not None:
                pad.SetNet(ni)
    pcbnew.SaveBoard(path, b)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec")
    ap.add_argument("outdir")
    a = ap.parse_args()
    spec = json.load(open(a.spec, encoding="utf-8"))
    os.makedirs(a.outdir, exist_ok=True)
    # 收集并提取符号定义
    lib_blocks = {}
    if spec.get("pwr_flags"):
        lib_blocks["PWR_FLAG"] = extract_symbol_block(os.path.join(SYM_DIR, "power.kicad_sym"), "PWR_FLAG")
    for part in spec["parts"]:
        lib_id = part["sym"]
        if lib_id in lib_blocks:
            continue
        lib, sname = lib_id.split(":", 1)
        # 项目级库优先
        proj_lib = os.path.join(a.outdir, "lib", lib + ".kicad_sym")
        path = proj_lib if os.path.isfile(proj_lib) else find_symbol_lib(lib_id)
        lib_blocks[lib_id] = extract_symbol_block(path, sname)
    p1 = build_sch(spec, a.outdir, lib_blocks)
    p2 = build_pcb(spec, a.outdir)
    print("SCH:", p1)
    print("PCB:", p2)


if __name__ == "__main__":
    main()
