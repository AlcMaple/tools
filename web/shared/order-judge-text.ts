export const judgeDocText = (text: string): string => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
