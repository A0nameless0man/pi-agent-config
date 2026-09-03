---
name: kicad-pcb-design
description: "KiCad 9 画 PCB 全流程:从器件调查(kicad-pin-check)→原理图→PCB 布局→布线(Freerouting 自动布线与手动布线双路径)→DRC 清零→生产文件(Gerber/钻孔/BOM/贴片坐标)。触发词:画 PCB、layout、布线、出 Gerber、生产文件、原理图到 PCB。适用于本机 KiCad 9.0(kicad-cli),配合 skills/kicad-pin-check 与 skills/kicad-pcb-review。"
---

# 画 PCB:原理图 → 生产图(KiCad 9)

## 流程总览

```
Stage 0 器件调查(kicad-pin-check)→ 每个器件有 pinout/封装结论与可用库
Stage 1 原理图     → <板>.kicad_sch,ERC 通过
Stage 2 建板       → <板>.kicad_pcb,器件放置完成,ratsnest 网络建立
Stage 3 布局       → 功能分区/去耦/电源路径就位
Stage 4 布线       → 路径 A:Freerouting 自动;路径 B:手动规范;混合亦可
Stage 5 DRC 清零   → kicad-cli pcb drc 无 error(warning 逐条归类)
Stage 6 生产文件   → Gerber + 钻孔 + BOM + 贴片坐标,打包交付
Stage 7 最后验证   → 交付前自检清单(产物清点/复跑/渲染读图),全部机器可查
```

一条纪律:**每个 Stage 结尾都有机器可查的验收产物**,不过不进下一 Stage。调试循环发生在 Stage 内部,不允许带着 ERC/DRC 错误往下走。

本机环境(Windows):

```
KiCad 9.0      C:/Program Files/KiCad/9.0/
kicad-cli      C:/Program Files/KiCad/9.0/bin/kicad-cli.exe   (Git Bash: /c/Program Files/KiCad/9.0/bin/kicad-cli.exe)
KiCad Python   C:/Program Files/KiCad/9.0/bin/python.exe      (pcbnew 模块只能用它导入,系统 Python 不行)
符号/封装库     C:/Program Files/KiCad/9.0/share/kicad/{symbols,footprints}/
```

## Stage 0 — 器件调查

对 BOM 中每个器件调用 **kicad-pin-check** skill。产出的封装结论(精确封装名)与库文件(内置或手画)是后续一切的地基。BOM 料号按 TI D 后缀惯例标准化(SN74HCxxxD → SOIC)。

## Stage 1 — 原理图

### 推荐工作流:netlist JSON 为单一事实源

原理图手工连线在文本环境下易错(交叉、漏连、悬空)。推荐把**逻辑连接表(netlist JSON)作为事实源**,脚本生成 .kicad_sch 与 .kicad_pcb(Stage 2),天然一致:

```json
{
  "name": "led_blinker",
  "parts": [
    {"ref": "U1", "sym": "Timer:LM555xN",  "value": "LM555",  "fp": "Package_DIP:DIP-8_W7.62mm",          "at": [40, 60], "rot": 0},
    {"ref": "U2", "sym": "74xx:74HC138",   "value": "74HC138","fp": "Package_SO:SOIC-16_3.9x9.9mm_P1.27mm","at": [80, 60], "rot": 0},
    {"ref": "R1", "sym": "Device:R",       "value": "10k",    "fp": "Resistor_SMD:R_0805_2012Metric",      "at": [25, 45], "rot": 90}
  ],
  "nets": {
    "+5V":  [["U1", "VCC"], ["U2", "VCC"], ["C1", "1"]],
    "GND":  [["U1", "GND"], ["U2", "GND"], ["C1", "2"]],
    "CLK":  [["U1", "3"], ["U2", "A0"]]
  },
  "board": {"w": 60, "h": 40}
}
```

生成命令(skill 自带脚本,见 `scripts/build_board.py`;或按下方骨架自写):

```
KiCad python(自带 pcbnew 模块)执行:
"C:/Program Files/KiCad/9.0/bin/python.exe" skills/kicad-pcb-design/scripts/build_board.py spec.json <outdir>
```

### 手写 .kicad_sch 要点(不用脚本时)

- 顶层结构:`(kicad_sch (version 20250114) (generator "eeschema") ... (lib_symbols <符号定义内嵌>) <导线/标签/符号实例> (sheet_instances ...) )`
- **lib_symbols 必须内嵌**用到的符号完整定义——从库文件把 `(symbol "74HC138" ...)` 整块拷进来,lib_id 前缀对应库名(`74xx:74HC138`)
- 符号实例必须有 `(instances (project "<工程名>" (path "/<sheet-uuid>" (reference "U2") (unit 1))))`,否则 BOM/网表里没有位号
- 逻辑连接用**网络标签(label)**而非长导线:同名字段全局相连,原理图干净且不易错
- 电源符号用 `power:GND` / `power:+5V`,隐含电源网络
- 验收:`kicad-cli sch erc <板>.kicad_sch --severity-error --severity-warning -o erc.rpt`,报告无 error 才进 Stage 2

## Stage 2 — 建板

两种路径,选一:

**A. 脚本生成**(推荐,与 Stage 1 同一 spec):build_board.py 直接产出带 footprint 放置与网络定义的 .kicad_pcb 骨架(未布线,ratsnest 即飞线)。已知边界:
- 内置库与 `<outdir>/lib/*.kicad_sym` 项目库均会自动查找(手画库放这即可,无需改脚本)
- **不支持 extends 派生符号**(根块无 pin):遇到先把父符号块全局改名扁平化;派生块嵌入 lib_symbols 会整图加载失败
- 生成的 sch 有系统性 parity 伪差异(局部 label 网名带 `/` 前缀、footprint 无库昵称、NC 伪网络未写回 pad)——见 Stage 5 的 parity 说明,不要被 100+ 条伪差异吓到,也不要假装它们不存在

**B. 手写 .kicad_pcb**:顶层 `(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6)) ...)`;依次定义 nets(`(net 1 "GND")`)→ 板框(`gr_line` 于 `Edge.Cuts` 层,矩形闭合)→ footprint 实例(从 .pretty 拷 `(footprint ...)` 块,改 at/位号属性/加 `(property "Reference" "U1")`)→ 后续 segment/via。

footprint 实例从封装库复制时:库名前缀写库表中的昵称(如 `Package_SO:SOIC-16_3.9x9.9mm_P1.27mm`),手画库写 `lib:符号名` 且 .pretty 目录在工程内。

验收:`kicad-cli pcb drc <板>.kicad_pcb --format json -o drc.json` 中 connectivity 报告的未连接项 = 全部 ratsnest(正常,尚未布线),**不允许**出现 footprint 解析错误或 net 未定义。

## Stage 3 — 布局规则(检查单)

**核心纪律:布局时就要考虑主要线路走向(place for routing)。** 画出信号主干(时钟链、总线、电源树)的期望走向,让源→路径→宿的引脚大致对齐或同向排布; 密集并行的总线(如 Y0-Y7 → LED 阵列)让目标器件引脚顺序与阵列顺序一致,避免交叉。**布不通时第一反应是回 Stage 3 调整布局**(旋转器件、换行对齐、拉开通道),而不是死磕布线参数; 升级多层板或扩大板框是最后手段(且需向需求方确认)。

- 电源入口 → 滤波电容 → 器件,路径最短;每片 IC 的 VCC 引脚 2mm 内一颗 100nF 去耦(74 板密度低,0805 即可)
- 时钟/振荡器件(LM555)远离板边与信号输出排针
- 输入(拨码/排针)一侧、输出(LED/驱动)另一侧,信号从左到右流
- SOIC 走线通道预留:宽体 SOIC-20/24 引脚间距 1.27mm,相邻引脚间过通道须 ≥0.2mm 线宽或直接两 pin 间不过线
- 板边器件外缘距 Edge.Cuts ≥3mm;安装孔若需要,距器件 ≥2.5mm
- **封装原点陷阱**:排针类(PinHeader/PinSocket_2xN)封装原点 = pin1 非几何中心——按中心坐标摆放会让首排越出板边,DRC copper_edge 才暴露;摆放前先看 .kicad_mod 的 pad 分布
- 布局验收:无 footprint 重叠(DRC 会报 courtyard overlap),器件位号丝印不互压

**Stage 3 视觉检查点(强制)**:渲染并**实际读图**——
```bash
kicad-cli pcb render <板>.kicad_pcb -o layout_check.png --width 1400 --height 800 --side top
```
用视觉能力读 layout_check.png:器件重叠、位号互压、极性方向、去耦电容是否贴 IC、整体信号流向是否符合预期。**禁止只凭坐标数据想象布局**,看出来的问题回布局修正。

## Stage 4 — 布线

### 路径 A — Freerouting 自动布线(推荐先试)

**一键管线(skill 自带)**:`scripts/autoroute.py` 封装了完整往返——导 DSN、注入板缘 keepout、跑 Freerouting headless、日志判读、SES 回导并保存:

```bash
KPY="C:/Program Files/KiCad/9.0/bin/python.exe"
"$KPY" <skill目录>/scripts/autoroute.py <板>.kicad_pcb [timeout秒=300]
# 成功标志: "SES imported back";日志存 <板>_freerouting.log 可查 unrouted 计数
```

它内部处理了两个手敲踩不到就会翻车的坑(细节见展开):① **netclass via 规格**必须在建板时设好(否则 FR 按 DSN 默认 0.6/0.3 布过孔,DRC 报 24 条 via_diameter/annular_width);② **板缘禁布环带**——Freerouting 不懂 KiCad 的 copper-edge-clearance,脚本会在 DSN 里注入 4 条 0.4mm keepout 带,否则贴边走线过不了 DRC。

**首次安装**(一次性;已有可跳过):

```bash
# 检测
ls ~/tools/freerouting/freerouting.jar 2>/dev/null && echo FR_OK
ls ~/tools/jdk25/jdk-*/bin/java.exe 2>/dev/null && echo JAVA25_OK

# JRE 25:国内走清华 Adoptium 镜像(直连 github 常超时;jar 本体可能需代理)
mkdir -p ~/tools/jdk25 ~/tools/freerouting
curl -L -o /tmp/jre25.zip "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jre/x64/windows/OpenJDK25U-jre_x64_windows_hotspot_25.0.4.1_1.zip"
unzip -q /tmp/jre25.zip -d ~/tools/jdk25 && rm /tmp/jre25.zip   # → ~/tools/jdk25/jdk-25.0.4.1+1-jre/
curl -L -o ~/tools/freerouting/freerouting.jar \
  "https://github.com/freerouting/freerouting/releases/download/v2.2.4/freerouting-2.2.4.jar"  # ~58MB
# Linux 版:同目录换 OpenJDK25U-jre_x64_linux_hotspot_25.0.4.1_1.tar.gz
```

**版本纪律**(RV74 血泪 + 本机实测):Freerouting **v2.2.x 必须配 Java 25**(class file v69);v1.x 是 GUI-only(HeadlessException);v2.0.x headless 可跑但 `-do` 写空文件。**别用 apt/snap 的 java(通常 11/17),太老**。

<details>
<summary>手敲等效命令(理解管线用;日常用脚本)</summary>

```bash
KPY="/c/Program Files/KiCad/9.0/bin/python.exe"
J25=$(ls ~/tools/jdk25/jdk-*/bin/java.exe 2>/dev/null || ls ~/tools/jdk25/jdk-*/bin/java)

# 1) 导出 Specctra DSN(pcbnew Python 桥,KiCad 9 仍可用)
"$KPY" -c "import pcbnew; b=pcbnew.LoadBoard('<板>.kicad_pcb'); pcbnew.ExportSpecctraDSN(b, '<板>.dsn')"

# 2) headless 自动布线(注意:输出是 .ses,不是 .dsn!写错后缀得空文件)
"$J25" -jar ~/tools/freerouting/freerouting.jar -de <板>.dsn -do <板>.ses --gui.enabled=false 2>&1 | tee freerouting.log

# 3) 日志判读: "session completed: started with N unrouted" —— v2.2.4 零 unrouted 时省略 annotation
# 4) 回导 SES
"$KPY" -c "import pcbnew; b=pcbnew.LoadBoard('<板>.kicad_pcb'); pcbnew.ImportSpecctraSES(b, '<板>.ses'); pcbnew.SaveBoard('<板>.kicad_pcb', b)"
```

</details>

### 路径 B — 手动布线规范

- 线宽:信号 0.25mm(≥0.2 过 SOIC 引脚间),电源 0.5mm,主干 GND/VCC 0.8mm 或铺铜
- 间距 ≥0.2mm(JLC 默认能力);过孔 0.8/0.4mm(与 netclass 声明一致,FR 也按这个布)
- 两层板策略:**F.Cu 优先水平走向,B.Cu 垂直走向**,换层用过孔;短同名 net 不允许跨层绕远
- 弯角 45°;禁止锐角(<90°)与直角——DRC/silk 环节会挑
- GND 铺铜:两顶层底层各铺一块 `(zone (net 1) (net_name "GND") (layer "F.Cu") ... (fill yes (thermal_gap 0.5))),` 铺铜在布线后做,`kicad-cli pcb drc` 前确认 zone 已填充(脚本路径:pcbnew python `ZONE_FILLER(b).Fill(b)`;CLI 无 fill 命令)
- 小规模板(net < 40)可用 skill 自带 `scripts/grid_route.py <板>.kicad_pcb`:两层网格 Lee 布线器(pad 实心 owner + margin keepout 双层模型),**作为 Freerouting 不可用时的兜底与教学参考;主力仍是路径 A**——手写布线器的边界情况极多,别重造轮子

**混合策略(实际最优)**:Freerouting 布通率 95%+ 时直接手补剩余;某 net 反复失败(如电源干道)时手动先锁定粗线,再跑 Freerouting。

**布不通的迭代顺序**:① 换层/换过孔位置重试 → ② 检查是否 ratsnest 虚边(MST 边失败但 net 或已连通) → ③ **回 Stage 3 调布局**(通道让位、器件旋转/对齐) → ④ 多层板/扩板(最后手段,需确认)。

### 布线验收

```
kicad-cli pcb drc <板>.kicad_pcb --format json -o drc.json
```

- `unconnected_items` 计数 = 0
- violations 中 severity=error 的条目 = 0(warning 逐条看,可留 silk/courtyard 类 minor 并记录)

## Stage 4.5 — 铺铜(GND/VCC/悬空铜)

布线完成后、DRC 清零前铺铜。skill 自带一键脚本(幂等,可重跑):

```bash
KPY="C:/Program Files/KiCad/9.0/bin/python.exe"
"$KPY" <skill目录>/scripts/add_pours.py <板>.kicad_pcb            # GND→B.Cu thermal + VCC(+5V)→F.Cu solid
# 可选: --gnd-layer/--vcc-layer/--edge-gap 0.25
```

**实测参数与教训**:

- **GND 底层整板** pour,thermal relief(gap/spoke 0.3mm)——手焊友好;
- **VCC/电源顶层整板** pour,**solid 连接**:thermal 辐条会被邻近走线挤占导致 DRC `starved_thermal`(电源 pad 全连接是主流实践,不牺牲什么)
- zone outline 内缩板框 0.25mm(满足 copper-edge 0.3 + 余量);clearance 0.3、min thickness 0.25、孤岛自动移除(ALWAYS)
- **KiCad 9 python API 坑**:`pcbnew.Add()` 已移除→用 `board.Add(zone)`;`ZONE_FILLER(board).Fill([zones])`(构造绑 board,不再传参);solid 枚举叫 `ZONE_CONNECTION_FULL`(没有 SOLID);坐标全程 nm(`pcbnew.FromMM`)
- 铺铜后必须重跑 DRC:铺铜会暴露/引入新问题(thermal、clearance);铺铜后 Gerber 也要重导

**悬空铜(无 net thieving)——结论:设计端不做**(2026-09 网络调研,来源含 JLC 官方博客/KiCad 9 手册/实测):

- copper thieving(均流块)是**板厂拼板/电镀工序加的**,设计者无需自己做;设计端的"空区填铜"用实铜 GND/电源 pour 满足(JLC:整板实铜 = ideal,不铺会电镀厚度不均/蚀刻残余)
- 悬空大面积铜 = patch antenna(>λ/20 即天线效应);KiCad 无 net zone 的孤岛**永不自动删除**,误用会留悬空碎片——除非逐块加 stitching via(低速板 15~25mm 间距),否则不用无 net zone
- 双层板层分配定论:双面 GND 为主流(B 整板 + F 空余);本 skill 默认 B=GND + F=+5V pour,同样满足空区实铜与回流完整性(低速 74 板成立);多层板才考虑内层平面分工
- thermal 参数:gap 0.3 / spoke 0.5(JLC 要求两者 >0.25mm);pad connection:GND thermal(手焊友好)、电源 solid(避免 starved_thermal);via 永远实连(KiCad 行为)

## Stage 5 — DRC 清零(正式)

```
kicad-cli pcb drc <板>.kicad_pcb --all-track-errors --schematic-parity --format json -o drc.json
kicad-cli sch erc <板>.kicad_sch --format json -o erc.json
```

- `--schematic-parity`:PCB 与原理图位号/网络一致性。**实测注意**:脚本生成流程会产生系统性伪差异(网名 `/` 前缀、footprint 库昵称缺失、NC 伪网络),全 0 不可得;正确姿势是逐条区分——命名/库引用伪差异核实后豁免,电气真差异(连接不同/位号缺)必须修;给 NC pad 写回伪网络名、footprint 补库前缀后 parity 可归零
- 清零标准:**0 error**;warning 必须逐条归类(修复 / 明确豁免理由),不允许静默
- 常见 error 修复:silk over pad(移动丝印)、courtyard overlap(挪器件)、clearance(改走线)、missing footprint(库昵称错)

**Stage 5 视觉复核(强制)**:`pcb render`(top/bottom 各一张)+ `pcb export svg` 分层图,**逐张实际读图**——短路桥、锐角、细线、悬空线头、铺铜断裂这类问题 DRC 未必全报,人眼/视觉模型一眼即见。DRC 数值干净 + 视觉通过才算 Stage 5 完成。当前执行模型无视觉能力时,委托视觉模型子会话代读(与 review skill 同法:`pi -p --no-session --model <视觉模型> "读图 <png>,逐项回答…" > l3.txt`),委托输出落盘归档。

## Stage 6 — 生产文件(实测命令)

```bash
OUT=<板>_prod && mkdir -p "$OUT"           # kicad-cli 不建目录,必须先 mkdir
KC="/c/Program Files/KiCad/9.0/bin/kicad-cli.exe"
"$KC" pcb export gerbers <板>.kicad_pcb -o "$OUT/"        # 默认全层;加 -l "F.Cu,B.Cu,..." 可筛选
"$KC" pcb export drill   <板>.kicad_pcb -o "$OUT/"        # excellon,产出 .drl
"$KC" pcb export pos     <板>.kicad_pcb -o "$OUT/pos.csv" --units mm   # -o 要具体文件名,给目录不出文件
"$KC" sch export bom     <板>.kicad_sch -o "$OUT/bom.csv"
```

交付验收:制造必需层齐(F_Cu/B_Cu/F_Mask/B_Mask/F_SilkS/B_SilkS/F_Paste/Edge_Cuts,默认全层导出会含 User_*/Courtyard 等非制造层,可用 `-l` 筛选),`.drl` 钻孔齐,`pos.csv` 行数 = 器件数,BOM 分组合理;Zip 打包 `$OUT` 为 `<板>_gerbers.zip` 即为可上传板厂的生产包。

## Stage 7 — 最后验证(交付前自检,全部机器可查)

生产包打完不等于完事。逐项跑完以下自检,任何一项不过回对应 Stage:

1. **规则复跑**:`pcb drc --schematic-parity` 与 `sch erc` 对**最终版文件**再跑一遍(布线/回导可能引入新问题),0 error
2. **产物清点**:生产目录文件数/Gerber 层齐全性/`pos.csv` 行数 = 器件数/BOM 分组数(用 `ls`/`wc -l` 机械核对,不凭记忆)
3. **渲染读图**:top/bottom 渲染图逐张实际读图,确认无短路桥、器件方向正确、丝印可读
4. **交叉审核**:交给 `kicad-pcb-review` skill 做独立审核(不同视角),报告归档到项目 `review_reports/`
5. **要点复盘**:本板踩的新坑若具有普遍性,回馈更新本 skill(经验沉淀),让下一块板更顺

## 版本注意(RV74 跨版本经验,KiCad 9 主线)

KiCad 6→7 有过 S-表达式断代(version 声明、`fp_text reference` vs `property Reference`、stroke 语法),9.0 用 `property Reference/Value` + 完整 stroke 结构。**本 skill 全部按 KiCad 9 语法**;若未来迁移,直接用 KiCad 打开旧文件另存即可自动升级(kicad-cli 没有 pcb upgrade 子命令,仅 `kicad-cli sym upgrade` 验证符号库),手改前先比对 version 号。

## 演练参考

`~/kicad-skill-e2e/` 有走通全流程的板:led_blinker(555+161+138 流水灯,已验证 DRC 0 error + 生产包齐)与 rv74_alu / rv74_reg(74HC 系,用手画库)。首次使用本 skill 建议先读它们的 spec.json 与构建日志,复刻流程。
