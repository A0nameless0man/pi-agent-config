#!/usr/bin/env python
"""从 .kicad_sym 提取指定符号的 pin 表(number/name/电气类型/坐标)。

用法:
    python extract_pins.py <库文件.kicad_sym> <符号名> [符号名2 ...]
    python extract_pins.py "C:/Program Files/KiCad/9.0/share/kicad/symbols/74xx.kicad_sym" 74LS181

实现说明:不用正则跨块匹配(KiCad 9 库是多行缩进+嵌套 effects,正则易失配),
用括号配平定位符号块,再逐 "(pin " 起始块配平提取——对任意格式稳定。
"""
import sys


def find_block(src, start):
    """从 src[start](应为 '(')起做括号配平,返回 (块文本, 结束索引)。"""
    depth, i, in_str, esc = 0, start, False, False
    while i < len(src):
        c = src[i]
        if in_str:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
                if depth == 0:
                    return src[start:i + 1], i
        i += 1
    raise ValueError("unbalanced parens at %d" % start)


def extract_symbol(src, sym_name):
    """定位顶层 (symbol "<name>" 块(要求列首缩进恰好一个 tab,避免匹配子单元)。"""
    marker = '\n\t(symbol "%s"' % sym_name
    i = src.find(marker)
    if i < 0:
        # 退而求其次:任意缩进
        marker = '(symbol "%s"' % sym_name
        i = src.find(marker)
        if i < 0:
            return None
        i = src.rfind('(', 0, i + 1)
    block, _ = find_block(src, i)
    return block


def extract_pins(sym_block):
    """返回 [(number, name, etype, x, y, rot), ...];引脚在 _X_Y 子单元里,统一提取。"""
    pins = []
    i = 0
    while True:
        i = sym_block.find('(pin ', i)
        if i < 0:
            break
        try:
            block, end = find_block(sym_block, i)
        except ValueError:
            break
        toks = block.split()
        # (pin <etype> <style> (at x y rot) (length L) (name "...") ... (number "N")
        etype = toks[1]
        name = num = x = y = rot = ''
        j = block.find('(at ')
        if j >= 0:
            at_toks = block[j:j + 40].split()
            x, y, rot = at_toks[1], at_toks[2], (at_toks[3].rstrip(')') if len(at_toks) > 3 else '0')
        j = block.find('(name "')
        if j >= 0:
            name = block[j + 7:block.find('"', j + 7)]
        j = block.find('(number "')
        if j >= 0:
            num = block[j + 9:block.find('"', j + 9)]
        pins.append((num, name, etype, x, y, rot))
        i = end
    return pins


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    lib = sys.argv[1]
    src = open(lib, encoding='utf-8').read()
    for sym_name in sys.argv[2:]:
        block = extract_symbol(src, sym_name)
        if block is None:
            print("!! symbol %r not found in %s" % (sym_name, lib))
            continue
        print("# %s  (%s)" % (sym_name, lib))
        print("%-4s %-14s %-14s %8s %8s %4s" % ("num", "name", "etype", "x", "y", "rot"))
        for num, name, etype, x, y, rot in extract_pins(block):
            print("%-4s %-14s %-14s %8s %8s %4s" % (num, name, etype, x, y, rot))
        print()


if __name__ == '__main__':
    main()
