---
name: kicad-pcb-review
description: "审核 KiCad 9 PCB:三层审核——L1 机器检查(kicad-cli ERC/DRC/schematic-parity)、L2 结构化人工审核清单(器件/封装一致性引用 kicad-pin-check、电源完整性、布局、布线质量、丝印装配、BOM 可制造性)、L3 视觉读图审查(pcb render/export 渲染后实际看图)。产出三部分审核报告。触发词:审核 PCB、PCB review、DRC 报告、可制造性检查、出板前检查。"
---

# 审核 PCB(KiCad 9)

## 三层审核模型

| 层 | 查什么 | 怎么查 | 结论形态 |
|---|---|---|---|
| L1 机器检查 | 电气规则、连通性、PCB↔原理图一致性 | kicad-cli sch erc / pcb drc,JSON 解析 | error=0 才可过 |
| L2 人工清单 | 机器查不出的工程判断 | 逐项检查单,每项留证据 | 通过/风险/不通过 + 依据 |
| L3 视觉审查 | 看着不对的东西(丝印、锐角、短路桥) | 渲染图 + **实际读图** | 逐图结论 |

三层全部做完才出报告。**禁止只跑 DRC 就宣布"审核通过"**——DRC 只覆盖 L1。

被审对象输入:`<板>.kicad_sch` + `<板>.kicad_pcb`(若只给了 .kicad_pcb,L1 缺 ERC 与 parity,L2 的器件项标注降级)。

## L1 — 机器检查

```bash
KC="/c/Program Files/KiCad/9.0/bin/kicad-cli.exe"
"$KC" sch erc <板>.kicad_sch --format json -o erc.json 2>/dev/null || true
"$KC" pcb drc <板>.kicad_pcb --all-track-errors --schematic-parity --format json -o drc.json
```

解析要点(python 读 JSON):

- `violations[]`:每条有 `severity`(error/warning)、`type`、`description`、`items`;**先数 error = 0**,再逐条过 warning
- `unconnected_items[]`:布线完整性,必须为空
- `schematic_parity[]`:位号/net/属性 PCB 与原理图不一致——**区分两类**:
  - **真差异**(位号缺失/电气连接不同/footprint 不符)→ 打回
  - **命名/库引用伪差异**(生成器直写文件常见的 libsource 空、属性顺序、值格式差)→ 允许豁免,但必须**逐条或抽样成员级核对**证明电气一致,在报告列证据与放行条件(如"下版消除")
- `unresolved_variables`、`paraphrases`:一般为空,有则记录

结论规则:error > 0 → 整体**不通过**(无论 L2/L3 多好看);warning → 逐条列入报告,标"修复"或"豁免+理由"。**ERC 已知生成器豁免类**(脚本生成 sch 常见,核对后可批量豁免):`endpoint_off_grid`(1mil 线头栅格偏差)、`lib_symbol_issues`(直写 sch 的 libsource 空引用)——但豁免前必须用新鲜 netlist 证明连通正确。

## L2 — 结构化人工审核清单

逐项执行,每项在报告里留**可核对的证据**(命令输出片段/文件引用/读图所见),不接受"已检查"三个字。

### A. 器件与封装一致性(调 kicad-pin-check)

- [ ] 每个器件:符号 pin number/name ↔ 数据手册一致(pin-check Step 4 的核对输出作证据)
- [ ] 封装与采购型号后缀匹配:D 后缀配窄体 SOIC(14/16),DW 配宽体 SOIC-20W/24W,N 配 DIP;**74HC245/244/574 是 SOIC-20W 不是 SOIC-16**(RV74 踩过);74HC181 是 SOIC-24W
- [ ] 多单元器件(如 74HC00 内 4 门)所有单元都放置且未用单元输入已处理(接地或上拉,不悬空)
- [ ] NC/未用引脚:符号标 no_connect 或原理图加 no_connect 标志

### B. 电源完整性

- [ ] 每片 IC 的每个 VCC 引脚 2mm 内有 100nF 去耦电容(渲染图上可见电容紧贴)
- [ ] 电源走线宽度足够:≥0.5mm 或铺铜;电源树清晰(输入→LDO/直接→各支路)
- [ ] GND 完整:两层板至少一层 GND 铺铜无断裂(渲染图看铜皮连续性,避免走线把 GND 切成孤岛)
- [ ] 电源网络无仅靠细线串联的菊花链(级联去耦OK,但主干要粗)

### C. 布局

- [ ] 功能分区明确:输入侧/输出侧/时钟区不交叉
- [ ] 晶振/时钟器件(LM555)靠近其负载,远离板边和 LED 输出
- [ ] 器件距板边 ≥3mm;丝印位号不重叠、不压 pad、方向一致(读 R1~Rn 排向)
- [ ] 测试/排针位置可达:拨码开关、排针不在器件包围的死角里

### D. 布线质量

- [ ] 无锐角/直角走线(视觉扫 F.Cu/B.Cu 渲染图)
- [ ] 信号线宽 ≥0.2mm;电源 ≥0.5mm;无不明原因的 0.1mm 细线
- [ ] 过孔数量合理:同一 net 短距离内不反复换层(≥3 孔绕圈的查)
- [ ] 平行走线长距离(>20mm)间距 ≥2 倍线宽(抗串扰,74 板要求可放宽但记录)

### E. 丝印与装配

- [ ] 极性标识:LED、电解电容、IC pin1 标识在丝印层清晰
- [ ] 丝印不上 pad/过孔(DRC 会查,但人工确认可读性)
- [ ] 板名/版本/日期在丝印层(可追溯性)

### F. BOM 与可制造性

- [ ] BOM 料号完整且标准化(74 系统一厂商后缀,如 TI SN74HCxxxD;无 "R 10k" 这类不完整料号)
- [ ] 器件封装无一律手画(能用内置库就用内置;手画库须有 pin-check 报告背书)
- [ ] 最小线宽/间距/孔径不超板厂能力(JLC 默认:线/距 ≥0.127mm,孔 ≥0.3mm)
- [ ] pos.csv 器件数 = BOM = PCB 实例数(三方一致)

## L3 — 视觉审查(必须实际读图)

渲染命令:

```bash
# 整板 3D 视图(方向俯视,看布局/装配观感)
"$KC" pcb render <板>.kicad_pcb -o render_top.png --width 1600 --height 1200 --side top
# 分层 2D(查走线/铺铜细节,比 3D 更可靠)
"$KC" pcb export svg <板>.kicad_pcb -o render/ --layers "F.Cu,B.Cu,F.SilkS,B.SilkS,Edge.Cuts" --page-size-mode 2
# Gerber 级复核(生产文件出来后)
"$KC" pcb export gerbers <板>.kicad_pcb -o render/ --layers "F.Cu,B.Cu,F.Mask,Edge.Cuts"
```

然后用视觉能力**实际读图**(本 skill 预期在具备视觉能力的模型/沙箱中运行:read 工具直接读渲染出的 PNG/SVG,禁止凭文本报告或坐标数据想象板子长什么样),逐图检查:

> **主 agent 无视觉能力时**:用无头子进程派视觉模型读图(实测可用):
> ```bash
> pi -p --no-session --provider <provider> --model <视觉模型> --thinking high \
>   "读图 <png路径>,逐项回答:<具体检查项>" > L3_result.txt 2>&1
> ```
> 每张图独立派发,提示词里列明该图的检查清单;子进程输出落盘后人工归并进报告。

1. **顶层走线图**:短路桥风险点(平行密集区)、锐角、未铺铜孤岛
2. **底层走线图**:同上 + GND 铺铜连续性
3. **丝印图**:位号方向可读、极性标识、pin1 标记、无叠字
4. **整板 3D**:器件无重叠悬浮、高度冲突、装配观感
5. **Edge.Cuts**:板框闭合、圆角/缺口符合意图

读不清的细节放大再读;仍不确定的项在报告标 `unclear`,不许臆断通过。

## 审核报告模板

`<板>_review.md`,三部分齐全:

```markdown
# PCB 审核报告:<板名> <版本/日期>
## 结论:通过 / 有条件通过(附条件)/ 不通过
## 放行条件(有条件通过时必填)
<每条:编号 R1..Rn + 下版必改项>
## L1 机器检查
- ERC: <error/warning 计数,逐条列 warning>
- DRC: <error=0 证据,warning 逐条:修复/豁免+理由>
- schematic-parity: <一致/差异清单>
- unconnected: <0 / 清单>
## L2 人工清单(A~F 逐组)
| 项 | 结论 | 证据 |
|---|---|---|
| A-1 符号↔数据手册 | ✅ | pin-check 报告 <路径>,SN 差异 0 |
| B-1 去耦电容 | ⚠️ | U3 VCC 4mm 内无电容(渲染图见 …)→ 建议改 |
## L3 视觉审查
- F.Cu: <所见,引用渲染图路径>
- B.Cu: …
- 丝印/3D/板框: …
## 遗留与豁免
<未修复但接受的项,每条带理由>
```

## 通过标准

- L1 全部 error=0 且 unconnected 空、parity 一致
- L2 无"不通过"项;⚠️ 项均有修复计划或书面豁免
- L3 五张图全部实际读过,无未判读的 unclear 项(有则补查)
- 三部分在报告中可追溯(每条结论有证据引用)
