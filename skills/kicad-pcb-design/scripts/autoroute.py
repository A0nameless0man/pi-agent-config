"""Freerouting 自动布线管线: DSN 导出 → headless 布线 → SES 回导
用法: kicad-python autoroute.py <board.kicad_pcb> [timeout_s]
"""
import sys
import os
import glob
import subprocess
import time

import pcbnew

board_path = os.path.abspath(sys.argv[1])
timeout_s = int(sys.argv[2]) if len(sys.argv) > 2 else 300
workdir = os.path.dirname(board_path)
base = os.path.splitext(os.path.basename(board_path))[0]
dsn_path = os.path.join(workdir, base + ".dsn")
ses_path = os.path.join(workdir, base + ".ses")
fr_jar = os.path.expanduser("~/tools/freerouting/freerouting.jar")
java = os.path.expanduser("~/tools/jdk25/jre/bin/java.exe")
if not os.path.exists(java):
    java = os.path.expanduser("~/tools/jdk25/jre/bin/java")

board = pcbnew.LoadBoard(board_path)
pcbnew.ExportSpecctraDSN(board, dsn_path)

# 后处理: 在 DSN 中注入板缘禁布环带(Freerouting 不懂 KiCad 的 copper-edge-clearance)
# 带宽 = edge clearance 0.3mm + 信号线半宽 0.1mm = 0.4mm
import re as _re
text = open(dsn_path, encoding="utf-8").read()
mb = _re.search(r"\(boundary\s*\(path[^)]*?\)", text, _re.S)
nums = [int(v) for v in _re.findall(r"-?\d+", mb.group(0)) if True][1:]
xs, ys = nums[0::2], nums[1::2]
minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
BAND = 400
strips = [
    (minx, miny, minx + BAND, maxy),
    (maxx - BAND, miny, maxx, maxy),
    (minx, miny, maxx, miny + BAND),
    (minx, maxy - BAND, maxx, maxy),
]
ko = []
for (ax, ay, bx, by) in strips:
    pts = "%d %d  %d %d  %d %d  %d %d" % (ax, ay, bx, ay, bx, by, ax, by)
    for layer in ("F.Cu", "B.Cu"):
        ko.append("    (keepout (polygon %s %s) (rule (clearance 0)))" % (layer, pts))
text = text.replace("    (via ", "\n".join(ko) + "\n    (via ", 1)
open(dsn_path, "w", encoding="utf-8").write(text)
print("DSN exported + edge keepout:", os.path.basename(dsn_path), os.path.getsize(dsn_path), "bytes")

if os.path.exists(ses_path):
    os.remove(ses_path)
t0 = time.time()
proc = subprocess.run(
    [java, "-jar", fr_jar, "-de", dsn_path, "-do", ses_path, "--gui.enabled=false"],
    capture_output=True, text=True, timeout=timeout_s, cwd=workdir)
log = proc.stdout + proc.stderr
open(os.path.join(workdir, base + "_freerouting.log"), "w", encoding="utf-8", errors="replace").write(log)
# 关键行: unrouted 计数(v2.2.4 零 unrouted 时无 annotation = 成功)
interesting = [ln for ln in log.splitlines()
               if any(k in ln for k in ("unrouted", "completed", "Auto-router", "ERROR", "Exception"))]
for ln in interesting[-8:]:
    print("FR:", ln.strip()[:130])
print("elapsed: %.1fs, ses exists:" % (time.time() - t0), os.path.exists(ses_path))
if not os.path.exists(ses_path) or os.path.getsize(ses_path) == 0:
    print("SES FAILED")
    sys.exit(2)

# SES 回导
board2 = pcbnew.LoadBoard(board_path)
pcbnew.ImportSpecctraSES(board2, ses_path)
pcbnew.SaveBoard(board_path, board2)
print("SES imported back ->", os.path.basename(board_path))
