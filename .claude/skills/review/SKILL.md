---
name: review
description: 读取相关代码，从正确性、安全性和可维护性三个角度给出复查结果
when-to-use: 完成功能或修复后，需要在提交前检查改动时使用
allowed-tools: read_file, grep_search, list_files
context: inline
---
请复查 $ARGUMENTS。

按以下顺序输出：

1. 先列出会导致错误、数据丢失或安全问题的发现。
2. 再列出会增加维护成本的设计问题。
3. 每项发现给出文件位置、原因和最小修复建议。
4. 如果没有发现问题，明确说明检查过哪些范围以及仍未覆盖的风险。
