---
name: kicad-pin-check
description: "KiCad 9 器件引脚与封装调查:给定器件名称(如 74HC181D、LM555、STM32F103C8T6),查证 pinout 与封装选项、定位内置符号/封装库、核对符号引脚与数据手册一致性;内置库缺失时负责查数据手册并手画 .kicad_sym 符号与 .pretty 封装(不是给建议),产出器件调查报告。画 PCB 前的第一步。触发词:查器件引脚、pinout、封装调查、选封装、库缺失、手画符号库、器件调研。"
---

# 器件引脚与封装调查(KiCad 9)

## 定位

这是画 PCB 流程的第一步(下游是 `kicad-pcb-design`)。输入一个器件名称,输出一份**器件调查报告**:引脚定义、封装结论、库位置(或新生成的库文件)。调查必须以**数据手册为唯一权威依据**——库文件、记忆、常识都只能作为线索,不能作为结论。

**缺库时你的职责是造库**:查数据手册、手画符号与封装、验证可用——而不是在报告里写"建议用户自行下载"。

## 调查流程

### Step 1 — 确认器件身份

- 展开模糊名称:用户说"74HC181"时,确定完整采购型号(如 TI SN74HC181D,D 后缀 = SOIC 封装)
- 后缀语义(74 系惯例):`N` = DIP、`D` = SOIC、`DW` = 宽体 SOIC(20/24 pin)、`PW` = TSSOP;无后缀 = 逻辑功能确认,封装由本技能调查后选定
- HC / LS / HCT 差异必须记录:74HCxx(高速 CMOS)与 74LSxx(低功耗肖特基)同编号时**引脚兼容**(pin-compatible)但电气参数不同(输入阈值、驱动能力、功耗);pinout 可互引,采购料号不可混

### Step 2 — 数据手册查证

数据手册是 pinout 与封装的唯一权威。获取顺序:

1. 厂商官网直接下载(TI/AD/onsemi 均免费,搜 `<完整型号> datasheet pdf`)
2. 本地已有 PDF(先查项目目录)
3. 联网搜索 alldatasheet / datasheetspdf 等镜像(注意版本,选厂商原版)

从数据手册提取并记录:

- **引脚表(pin table)**:pin number ↔ pin name ↔ 方向/类型,逐 pin 记录,不留"大概"
- **封装选项**:该型号提供的封装家族及后缀(D/N/DW/PW…),每个封装的 pin count 与体宽
- **电源引脚**:VCC/GND 的 pin number(24 pin 的 74HC181 是 pin 12 = GND、pin 24 = VCC——MSI 芯片电源在角落的规律易记错,必须查)
- 特殊 pin:NC(内部不连)、n.c.(不接也可)、DNC——手画封装与符号时 NC 引脚必须保留 pad

**获取受阻时的规则**(2026-09 实测:TI 根本不产 SN74HC181,官方直链 404 是常态):

1. **换二供厂商**:74 系逻辑片找 ST(如 M74HC181)、NXP、Toshiba 同编号型号,pin-compatible;型号+`datasheet pdf` 搜原厂 PDF
2. **镜像站**:alldatasheet 等镜像可作中转,但下载后必须校验文件头是 `%PDF`(部分站点返回 HTML 伪装 200)
3. 全部失败才退回 pin-compatible 骨架路线(Step 5),并在报告中声明数据来源与风险

### Step 3 — 内置库定位(KiCad 9 本机)

本机标准安装路径(Windows):

```
符号库:  C:/Program Files/KiCad/9.0/share/kicad/symbols/<lib>.kicad_sym
封装库:  C:/Program Files/KiCad/9.0/share/kicad/footprints/<lib>.pretty/<footprint>.kicad_mod
CLI:     C:/Program Files/KiCad/9.0/bin/kicad-cli.exe
```

定位命令(Git Bash,路径含空格必须加引号):

```bash
SYM="/c/Program Files/KiCad/9.0/share/kicad/symbols"
# 精确符号名(引号内是符号名,匹配 (symbol "74HC00" ...)
grep -c "symbol \"74HC138\"" "$SYM/74xx.kicad_sym"
# 宽松搜索(符号可能带后缀或只存在于其他系列)
grep -oE '"74[A-Z]{0,3}(138|161)[^"]*"' "$SYM/74xx.kicad_sym" | sort -u
# 封装存在性
ls "/c/Program Files/KiCad/9.0/share/kicad/footprints/Package_SO.pretty/" | grep "SOIC-16"
```

**库命名陷阱(2026-09 实测 KiCad 9.0)**:

| 陷阱 | 事实 |
|---|---|
| 74xx 库只有 LS 系全量 | `74HC00/74/125/138/157/161/181/182/194/244/245/283/574` 中,库内精确存在的是 00/74/125/138/157/161/194/244/245/283/574 中的 **HC 版只有 00/74/125/138/244/245**;181/182/283/161/194/154/157/574 仅有 **74LS** 版 + 74HCT574。查到 74LS181 **不等于**有 74HC181,但 pinout 可作为手画起点(pin-compatible) |
| 4000 系列库名 | 是 `4xxx.kicad_sym`,不是 CMOS_4000.kicad_sym |
| 555 定时器 | `Timer.kicad_sym` 内是 LM555xN(DIP-8)/LM555xM(SOIC-8)/ICM7555x 等具体型号,没有裸名 "NE555" |
| 封装名 W 后缀 | 宽体 SOIC 带 W:`SOIC-20W_7.5x12.8mm_P1.27mm`、`SOIC-24W_7.5x15.4mm_P1.27mm`;窄体 16 pin 是 `SOIC-16_3.9x9.9mm_P1.27mm`。别按"SOIC-20_3.9x12.8mm"这类错误名找 |
| 项目级库优先 | 项目目录的 `*.kicad_sym` / `*.pretty` 与项目 `.kicad_pro` 的符号库表(`libraries.pinned_symbol_libs` / `pinned_footprint_libs`)优先于全局库;手画库放项目内最稳 |

### Step 4 — 一致性核对(库内已有该器件时)

库里有符号 ≠ 可以直接用。核对三要素,**任何一处对不上都按缺库处理(走 Step 5)**:

1. **符号 pin number ↔ 数据手册 pin table**:grep 出库内符号定义,逐 pin 比对 name 与 number
2. **符号 pin ↔ 封装 pad**:符号 pin 1 的位置/方向与封装 pad 1 的物理位置必须对应(注意 pin 1 标识方向、CCW vs 顺排)
3. **封装体宽与型号后缀匹配**:SOIC-14 窄体配 D 后缀,20/24 pin 宽体配 DW 后缀

```bash
# 提取库内符号的完整 pin 表(skill 自带脚本,括号配平解析,对 KiCad 9 多行缩进格式稳定):
python <skill目录>/scripts/extract_pins.py \
  "C:/Program Files/KiCad/9.0/share/kicad/symbols/74xx.kicad_sym" 74LS181 74HC138
# 输出列:num / name / etype / x / y / rot;与数据手册逐行比对
```

### Step 5 — 缺库手画(造库)

发现内置库没有目标器件(或 Step 4 核对失败)时,**造库**:

1. **选骨架**:从同 pin count 的库内符号复制(如 74HC181 用 74LS181 的 24-pin 符号做骨架;从零写则用下方模板)。pin-compatible 时 pin table 可继承,但仍须与数据手册逐 pin 核对后才能采用
2. **手画符号** `.kicad_sym`:关键是 pin table——每个 pin 的 `(number)`、`(name)`、`(pin <电气类型>)` 必须与数据手册一致。电气类型映射:输入→`input`、输出→`output`、双向(I/O)→`bidirectional`、三态→`tri_state`、电源→`power_in`、时钟→`input`+`clock` 形状、不确定→`passive`(宁保守勿乱标 power)
3. **手画封装** `.kicad_mod`:优先从同家族现有封装复制(如 SOIC-24W 直接用库内 `SOIC-24W_7.5x15.4mm_P1.27mm.kicad_mod`,通常无需自画);只有非标封装才从数据手册 mechanical drawing 逐 pad 算坐标(pin pitch × 序号 + 体宽/体长,单位 mm)
4. **放置位置**:项目级(推荐)`<项目>/lib/<器件>.kicad_sym`;注册靠**项目目录内 `sym-lib-table` 文件**(逐行 `(lib (name "rv74_74hc")(type "KiCad")(uri "${KIPRJMOD}/lib/rv74_74hc.kicad_sym")...)`),`.kicad_pro` 里的 pinned 列表只是界面置顶不是注册;验证用 `kicad-cli sym upgrade` 解析即结构合法
5. **闭环验证(嵌入测试,坑最多的一步)**:skill 自带最小模板 `reference/embed_test_minimal.kicad_sch`,复制后替换 lib_symbols 内的符号与实例即可。四个实测坑:
   - lib_symbols 内嵌符号主名必须带库昵称前缀(如 `rv74_74hc:74HC181`),子单元 `_1_0/_1_1` 不带——写错直接 **kicad-cli 段崩溃**(而非报错)
   - 符号实例缺 `(instances (project ...))` 或文件缺顶层 `sheet_instances` 亦崩/加载失败
   - `no_connect` 的 `(at)` 只能两坐标,带角度即加载失败
   - 电源 pin 要 0 错误须配电源符号 + `PWR_FLAG`
   通过标准:`kicad-cli sch erc` 0 error 0 warning

<details>
<summary>符号 S-表达式骨架(点击展开,复制改 pin table)</summary>

```
(kicad_symbol_lib (version 20241209) (generator kicad_symbol_editor) (generator_version "9.0")
  (symbol "74HC181" (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 0 25.4 0) (effects (font (size 1.27 1.27))))
    (property "Value" "74HC181" (at 0 -25.4 0) (effects (font (size 1.27 1.27))))
    (property "ki_keywords" "ALU 4-bit")
    (property "ki_description" "4-bit Arithmetic Logic Unit, SOIC-24")
    (property "ki_fp_filters" "SOIC*7.5x15.4mm*P1.27mm*")
    (symbol "74HC181_0_1"
      (rectangle (start -12.7 24.13) (end 12.7 -24.13)
        (stroke (width 0.254) (type default)) (fill (type background)))
    )
    (symbol "74HC181_1_1"
      (pin input line (at -17.78 21.59 0) (length 5.08)
        (name "~{A0}" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      ;; ... 逐 pin 复制此结构,改 (at y 坐标) (name) (number) (电气类型)
      (pin power_in line (at 0 29.21 270) (length 5.08)
        (name "VCC" (effects (font (size 1.27 1.27)))) (number "24" (effects (font (size 1.27 1.27)))))
      (pin power_in line (at 0 -29.21 90) (length 5.08)
        (name "GND" (effects (font (size 1.27 1.27)))) (number "12" (effects (font (size 1.27 1.27)))))
    )
  )
)
```

要点:pin `(at x y angle)` 中 x = ±(体半宽+引脚长),y 按数据手册顺序排布;`_0_1` 单元放图形、`_1_1` 单元放 pin;否定信号名用 KiCad 标记语法 `~{S0}`(渲染为上划线)。

</details>

<details>
<summary>封装 .kicad_mod 骨架(点击展开)</summary>

```
(footprint "SOIC-24W_7.5x15.4mm_P1.27mm" (version 20241229) (generator pcbnew)
  (layer "F.Cu") (descr "SOIC, 24 Pin, JEDEC MS-013, 7.5x15.4mm")
  (attr smd)
  (fp_text reference "REF**" (at 0 -8.7) (layer "F.SilkS"))
  (fp_text value "SOIC-24W_7.5x15.4mm_P1.27mm" (at 0 8.7) (layer "F.Fab"))
  (fp_line (start -3.875 -7.95) (end -3.875 -7.6) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
  ;; ...丝印/丝印脚标/ Courtyard 按库内同族文件抄
  (pad "1" smd roundrect (at -4.725 -13.97) (size 1.475 0.6) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
  ;; pad 2..12 沿左侧向下,pad 13..24 沿右侧向上;坐标 = (pitch/2)*(序号差),x=±4.725
  (pad "" smd roundrect (at 0 0) (size 3.5 14.2) (layers "F.Cu" "F.Mask") (solder_paste_margin -0.1)) ;; 散热焊盘(如有)
)
```

**绝大多数标准封装不要从零算**——库里已有(SOIC 全系、DIP 全系、0603/0805 等),`cp` 到项目 pretty 后改名即可。只有厂商专属非标封装才逐 pad 算坐标。

</details>

### Step 6 — 产出器件调查报告

报告(通常 `<项目>/part_reports/<器件>.md`)必须包含:

1. **身份**:完整型号、厂商、封装后缀语义
2. **引脚表**:pin number ↔ name ↔ 类型 ↔ 数据手册页码/章节(全部 pin,不得省略)
3. **封装结论**:选定封装(KiCad 库名精确写法)+ 依据(体宽/pitch/数据手册 mechanical)
4. **库结论**:`内置: <库名>:<符号名>` 或 `手画: <项目>/lib/xxx.kicad_sym(SOIC-24W 复用内置)`;手画的须附验证结果(erc/upgrade 通过)
5. **注意事项**:HC vs LS 差异、NC 引脚、多电源域、替代型号

## RV74 已验证对照表(2026-07 按 TI 数据手册逐片校正,封装名已更新为 KiCad 9 实际名称)

| 器件 | pin count | KiCad 9 封装(精确名) | 库状态(74xx.kicad_sym) |
|---|---|---|---|
| 74HC00 | 14 | `SOIC-14_3.9x8.7mm_P1.27mm` | ✅ HC 版在 |
| 74HC74 | 14 | `SOIC-14_3.9x8.7mm_P1.27mm` | ✅ HC 版在 |
| 74HC125 | 14 | `SOIC-14_3.9x8.7mm_P1.27mm` | ⚠️ 仅 74LS125 / 74LVC125 |
| 74HC138 | 16 | `SOIC-16_3.9x9.9mm_P1.27mm` | ✅ HC 版在 |
| 74HC157 | 16 | `SOIC-16_3.9x9.9mm_P1.27mm` | ⚠️ 仅 74LS157 |
| 74HC161 | 16 | `SOIC-16_3.9x9.9mm_P1.27mm` | ⚠️ 仅 74LS161 |
| 74HC182 | 16 | `SOIC-16_3.9x9.9mm_P1.27mm` | ⚠️ 仅 74LS182 |
| 74HC194 | 16 | `SOIC-16_3.9x9.9mm_P1.27mm` | ⚠️ 仅 74LS194 |
| 74HC283 | 16 | `SOIC-16_3.9x9.9mm_P1.27mm` | ⚠️ 仅 74LS283 |
| 74HC244 | 20 | `SOIC-20W_7.5x12.8mm_P1.27mm` | ✅ HC 版在 |
| 74HC245 | 20 | `SOIC-20W_7.5x12.8mm_P1.27mm` | ✅ HC 版在(**勿记成 SOIC-16**,RV74 踩过) |
| 74HC574 | 20 | `SOIC-20W_7.5x12.8mm_P1.27mm` | ⚠️ 仅 74LS574 / 74HCT574 |
| 74HC181 | 24 | `SOIC-24W_7.5x15.4mm_P1.27mm` | ❌ 仅 74LS181(**勿记成 SOIC-16**,22 signal + VCC24 + GND12);**TI 不产 HC181**,料号用 ST M74HC181M1R |
| 74HC154 | 24 | `SOIC-24W_7.5x15.4mm_P1.27mm` | ⚠️ 仅 74LS154 |

⚠️/❌ 项:符号需手画(pin-compatible 骨架)或直接用 74LS 版符号 + BOM 写 HC 料号(须在报告中显式声明此决定)。

**BOM 料号标准化**(RV74 惯例):能上 TI 的统一 TI D 后缀系列——SN74HC245D、SN74HC00D…;**注意例外**:TI 不产 HC181(唯一权威是 ST M74HC181,SOIC-24 后缀 M1R,即 M74HC181M1R)——料号以实际存在的原厂型号为准,不硬凑系列。手画符号的 `ki_fp_filters` 与 Value 属性都按此写;多 filter 用单字符串空格分隔(`"SOIC*7.5x15.4* TSSOP*"`),写成两个引号值会让 sym upgrade 报无法加载库

## 已知库缺口教训(RV74, 2026-07)

- KiCad(6.0 与 9.0 同样)74xx 库 LS 系列远全于 HC 系列;**画板前对每个 74HC 型号跑 Step 3**,别假设"这么常见的芯片库肯定有"
- `Connector_PinHeader_2.54mm.pretty` 最大 **2×40**;spec 要 2×50 排针时直接改 spec(2×25×2 或 2×40+1×20),不要试图手画排针
- 三种补救优先级:① pin-compatible 的 LS 符号 + HC 料号(须声明)② 复制 LS 符号改名为 HC(逐 pin 核对后)③ 从零手画(非 pin-compatible 或无骨架时)
