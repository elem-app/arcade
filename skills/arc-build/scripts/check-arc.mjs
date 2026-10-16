#!/usr/bin/env node

// src/skill-tools/check-arc-cli.ts
import { readFileSync } from "node:fs";

// node_modules/.pnpm/acorn@8.16.0/node_modules/acorn/dist/acorn.mjs
var astralIdentifierCodes = [509, 0, 227, 0, 150, 4, 294, 9, 1368, 2, 2, 1, 6, 3, 41, 2, 5, 0, 166, 1, 574, 3, 9, 9, 7, 9, 32, 4, 318, 1, 78, 5, 71, 10, 50, 3, 123, 2, 54, 14, 32, 10, 3, 1, 11, 3, 46, 10, 8, 0, 46, 9, 7, 2, 37, 13, 2, 9, 6, 1, 45, 0, 13, 2, 49, 13, 9, 3, 2, 11, 83, 11, 7, 0, 3, 0, 158, 11, 6, 9, 7, 3, 56, 1, 2, 6, 3, 1, 3, 2, 10, 0, 11, 1, 3, 6, 4, 4, 68, 8, 2, 0, 3, 0, 2, 3, 2, 4, 2, 0, 15, 1, 83, 17, 10, 9, 5, 0, 82, 19, 13, 9, 214, 6, 3, 8, 28, 1, 83, 16, 16, 9, 82, 12, 9, 9, 7, 19, 58, 14, 5, 9, 243, 14, 166, 9, 71, 5, 2, 1, 3, 3, 2, 0, 2, 1, 13, 9, 120, 6, 3, 6, 4, 0, 29, 9, 41, 6, 2, 3, 9, 0, 10, 10, 47, 15, 199, 7, 137, 9, 54, 7, 2, 7, 17, 9, 57, 21, 2, 13, 123, 5, 4, 0, 2, 1, 2, 6, 2, 0, 9, 9, 49, 4, 2, 1, 2, 4, 9, 9, 55, 9, 266, 3, 10, 1, 2, 0, 49, 6, 4, 4, 14, 10, 5350, 0, 7, 14, 11465, 27, 2343, 9, 87, 9, 39, 4, 60, 6, 26, 9, 535, 9, 470, 0, 2, 54, 8, 3, 82, 0, 12, 1, 19628, 1, 4178, 9, 519, 45, 3, 22, 543, 4, 4, 5, 9, 7, 3, 6, 31, 3, 149, 2, 1418, 49, 513, 54, 5, 49, 9, 0, 15, 0, 23, 4, 2, 14, 1361, 6, 2, 16, 3, 6, 2, 1, 2, 4, 101, 0, 161, 6, 10, 9, 357, 0, 62, 13, 499, 13, 245, 1, 2, 9, 233, 0, 3, 0, 8, 1, 6, 0, 475, 6, 110, 6, 6, 9, 4759, 9, 787719, 239];
var astralIdentifierStartCodes = [0, 11, 2, 25, 2, 18, 2, 1, 2, 14, 3, 13, 35, 122, 70, 52, 268, 28, 4, 48, 48, 31, 14, 29, 6, 37, 11, 29, 3, 35, 5, 7, 2, 4, 43, 157, 19, 35, 5, 35, 5, 39, 9, 51, 13, 10, 2, 14, 2, 6, 2, 1, 2, 10, 2, 14, 2, 6, 2, 1, 4, 51, 13, 310, 10, 21, 11, 7, 25, 5, 2, 41, 2, 8, 70, 5, 3, 0, 2, 43, 2, 1, 4, 0, 3, 22, 11, 22, 10, 30, 66, 18, 2, 1, 11, 21, 11, 25, 7, 25, 39, 55, 7, 1, 65, 0, 16, 3, 2, 2, 2, 28, 43, 28, 4, 28, 36, 7, 2, 27, 28, 53, 11, 21, 11, 18, 14, 17, 111, 72, 56, 50, 14, 50, 14, 35, 39, 27, 10, 22, 251, 41, 7, 1, 17, 5, 57, 28, 11, 0, 9, 21, 43, 17, 47, 20, 28, 22, 13, 52, 58, 1, 3, 0, 14, 44, 33, 24, 27, 35, 30, 0, 3, 0, 9, 34, 4, 0, 13, 47, 15, 3, 22, 0, 2, 0, 36, 17, 2, 24, 20, 1, 64, 6, 2, 0, 2, 3, 2, 14, 2, 9, 8, 46, 39, 7, 3, 1, 3, 21, 2, 6, 2, 1, 2, 4, 4, 0, 19, 0, 13, 4, 31, 9, 2, 0, 3, 0, 2, 37, 2, 0, 26, 0, 2, 0, 45, 52, 19, 3, 21, 2, 31, 47, 21, 1, 2, 0, 185, 46, 42, 3, 37, 47, 21, 0, 60, 42, 14, 0, 72, 26, 38, 6, 186, 43, 117, 63, 32, 7, 3, 0, 3, 7, 2, 1, 2, 23, 16, 0, 2, 0, 95, 7, 3, 38, 17, 0, 2, 0, 29, 0, 11, 39, 8, 0, 22, 0, 12, 45, 20, 0, 19, 72, 200, 32, 32, 8, 2, 36, 18, 0, 50, 29, 113, 6, 2, 1, 2, 37, 22, 0, 26, 5, 2, 1, 2, 31, 15, 0, 24, 43, 261, 18, 16, 0, 2, 12, 2, 33, 125, 0, 80, 921, 103, 110, 18, 195, 2637, 96, 16, 1071, 18, 5, 26, 3994, 6, 582, 6842, 29, 1763, 568, 8, 30, 18, 78, 18, 29, 19, 47, 17, 3, 32, 20, 6, 18, 433, 44, 212, 63, 33, 24, 3, 24, 45, 74, 6, 0, 67, 12, 65, 1, 2, 0, 15, 4, 10, 7381, 42, 31, 98, 114, 8702, 3, 2, 6, 2, 1, 2, 290, 16, 0, 30, 2, 3, 0, 15, 3, 9, 395, 2309, 106, 6, 12, 4, 8, 8, 9, 5991, 84, 2, 70, 2, 1, 3, 0, 3, 1, 3, 3, 2, 11, 2, 0, 2, 6, 2, 64, 2, 3, 3, 7, 2, 6, 2, 27, 2, 3, 2, 4, 2, 0, 4, 6, 2, 339, 3, 24, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 30, 2, 24, 2, 7, 1845, 30, 7, 5, 262, 61, 147, 44, 11, 6, 17, 0, 322, 29, 19, 43, 485, 27, 229, 29, 3, 0, 208, 30, 2, 2, 2, 1, 2, 6, 3, 4, 10, 1, 225, 6, 2, 3, 2, 1, 2, 14, 2, 196, 60, 67, 8, 0, 1205, 3, 2, 26, 2, 1, 2, 0, 3, 0, 2, 9, 2, 3, 2, 0, 2, 0, 7, 0, 5, 0, 2, 0, 2, 0, 2, 2, 2, 1, 2, 0, 3, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 1, 2, 0, 3, 3, 2, 6, 2, 3, 2, 3, 2, 0, 2, 9, 2, 16, 6, 2, 2, 4, 2, 16, 4421, 42719, 33, 4381, 3, 5773, 3, 7472, 16, 621, 2467, 541, 1507, 4938, 6, 8489];
var nonASCIIidentifierChars = "\u200C\u200D\xB7\u0300-\u036F\u0387\u0483-\u0487\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7\u0610-\u061A\u064B-\u0669\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u06F0-\u06F9\u0711\u0730-\u074A\u07A6-\u07B0\u07C0-\u07C9\u07EB-\u07F3\u07FD\u0816-\u0819\u081B-\u0823\u0825-\u0827\u0829-\u082D\u0859-\u085B\u0897-\u089F\u08CA-\u08E1\u08E3-\u0903\u093A-\u093C\u093E-\u094F\u0951-\u0957\u0962\u0963\u0966-\u096F\u0981-\u0983\u09BC\u09BE-\u09C4\u09C7\u09C8\u09CB-\u09CD\u09D7\u09E2\u09E3\u09E6-\u09EF\u09FE\u0A01-\u0A03\u0A3C\u0A3E-\u0A42\u0A47\u0A48\u0A4B-\u0A4D\u0A51\u0A66-\u0A71\u0A75\u0A81-\u0A83\u0ABC\u0ABE-\u0AC5\u0AC7-\u0AC9\u0ACB-\u0ACD\u0AE2\u0AE3\u0AE6-\u0AEF\u0AFA-\u0AFF\u0B01-\u0B03\u0B3C\u0B3E-\u0B44\u0B47\u0B48\u0B4B-\u0B4D\u0B55-\u0B57\u0B62\u0B63\u0B66-\u0B6F\u0B82\u0BBE-\u0BC2\u0BC6-\u0BC8\u0BCA-\u0BCD\u0BD7\u0BE6-\u0BEF\u0C00-\u0C04\u0C3C\u0C3E-\u0C44\u0C46-\u0C48\u0C4A-\u0C4D\u0C55\u0C56\u0C62\u0C63\u0C66-\u0C6F\u0C81-\u0C83\u0CBC\u0CBE-\u0CC4\u0CC6-\u0CC8\u0CCA-\u0CCD\u0CD5\u0CD6\u0CE2\u0CE3\u0CE6-\u0CEF\u0CF3\u0D00-\u0D03\u0D3B\u0D3C\u0D3E-\u0D44\u0D46-\u0D48\u0D4A-\u0D4D\u0D57\u0D62\u0D63\u0D66-\u0D6F\u0D81-\u0D83\u0DCA\u0DCF-\u0DD4\u0DD6\u0DD8-\u0DDF\u0DE6-\u0DEF\u0DF2\u0DF3\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\u0E50-\u0E59\u0EB1\u0EB4-\u0EBC\u0EC8-\u0ECE\u0ED0-\u0ED9\u0F18\u0F19\u0F20-\u0F29\u0F35\u0F37\u0F39\u0F3E\u0F3F\u0F71-\u0F84\u0F86\u0F87\u0F8D-\u0F97\u0F99-\u0FBC\u0FC6\u102B-\u103E\u1040-\u1049\u1056-\u1059\u105E-\u1060\u1062-\u1064\u1067-\u106D\u1071-\u1074\u1082-\u108D\u108F-\u109D\u135D-\u135F\u1369-\u1371\u1712-\u1715\u1732-\u1734\u1752\u1753\u1772\u1773\u17B4-\u17D3\u17DD\u17E0-\u17E9\u180B-\u180D\u180F-\u1819\u18A9\u1920-\u192B\u1930-\u193B\u1946-\u194F\u19D0-\u19DA\u1A17-\u1A1B\u1A55-\u1A5E\u1A60-\u1A7C\u1A7F-\u1A89\u1A90-\u1A99\u1AB0-\u1ABD\u1ABF-\u1ADD\u1AE0-\u1AEB\u1B00-\u1B04\u1B34-\u1B44\u1B50-\u1B59\u1B6B-\u1B73\u1B80-\u1B82\u1BA1-\u1BAD\u1BB0-\u1BB9\u1BE6-\u1BF3\u1C24-\u1C37\u1C40-\u1C49\u1C50-\u1C59\u1CD0-\u1CD2\u1CD4-\u1CE8\u1CED\u1CF4\u1CF7-\u1CF9\u1DC0-\u1DFF\u200C\u200D\u203F\u2040\u2054\u20D0-\u20DC\u20E1\u20E5-\u20F0\u2CEF-\u2CF1\u2D7F\u2DE0-\u2DFF\u302A-\u302F\u3099\u309A\u30FB\uA620-\uA629\uA66F\uA674-\uA67D\uA69E\uA69F\uA6F0\uA6F1\uA802\uA806\uA80B\uA823-\uA827\uA82C\uA880\uA881\uA8B4-\uA8C5\uA8D0-\uA8D9\uA8E0-\uA8F1\uA8FF-\uA909\uA926-\uA92D\uA947-\uA953\uA980-\uA983\uA9B3-\uA9C0\uA9D0-\uA9D9\uA9E5\uA9F0-\uA9F9\uAA29-\uAA36\uAA43\uAA4C\uAA4D\uAA50-\uAA59\uAA7B-\uAA7D\uAAB0\uAAB2-\uAAB4\uAAB7\uAAB8\uAABE\uAABF\uAAC1\uAAEB-\uAAEF\uAAF5\uAAF6\uABE3-\uABEA\uABEC\uABED\uABF0-\uABF9\uFB1E\uFE00-\uFE0F\uFE20-\uFE2F\uFE33\uFE34\uFE4D-\uFE4F\uFF10-\uFF19\uFF3F\uFF65";
var nonASCIIidentifierStartChars = "\xAA\xB5\xBA\xC0-\xD6\xD8-\xF6\xF8-\u02C1\u02C6-\u02D1\u02E0-\u02E4\u02EC\u02EE\u0370-\u0374\u0376\u0377\u037A-\u037D\u037F\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03F5\u03F7-\u0481\u048A-\u052F\u0531-\u0556\u0559\u0560-\u0588\u05D0-\u05EA\u05EF-\u05F2\u0620-\u064A\u066E\u066F\u0671-\u06D3\u06D5\u06E5\u06E6\u06EE\u06EF\u06FA-\u06FC\u06FF\u0710\u0712-\u072F\u074D-\u07A5\u07B1\u07CA-\u07EA\u07F4\u07F5\u07FA\u0800-\u0815\u081A\u0824\u0828\u0840-\u0858\u0860-\u086A\u0870-\u0887\u0889-\u088F\u08A0-\u08C9\u0904-\u0939\u093D\u0950\u0958-\u0961\u0971-\u0980\u0985-\u098C\u098F\u0990\u0993-\u09A8\u09AA-\u09B0\u09B2\u09B6-\u09B9\u09BD\u09CE\u09DC\u09DD\u09DF-\u09E1\u09F0\u09F1\u09FC\u0A05-\u0A0A\u0A0F\u0A10\u0A13-\u0A28\u0A2A-\u0A30\u0A32\u0A33\u0A35\u0A36\u0A38\u0A39\u0A59-\u0A5C\u0A5E\u0A72-\u0A74\u0A85-\u0A8D\u0A8F-\u0A91\u0A93-\u0AA8\u0AAA-\u0AB0\u0AB2\u0AB3\u0AB5-\u0AB9\u0ABD\u0AD0\u0AE0\u0AE1\u0AF9\u0B05-\u0B0C\u0B0F\u0B10\u0B13-\u0B28\u0B2A-\u0B30\u0B32\u0B33\u0B35-\u0B39\u0B3D\u0B5C\u0B5D\u0B5F-\u0B61\u0B71\u0B83\u0B85-\u0B8A\u0B8E-\u0B90\u0B92-\u0B95\u0B99\u0B9A\u0B9C\u0B9E\u0B9F\u0BA3\u0BA4\u0BA8-\u0BAA\u0BAE-\u0BB9\u0BD0\u0C05-\u0C0C\u0C0E-\u0C10\u0C12-\u0C28\u0C2A-\u0C39\u0C3D\u0C58-\u0C5A\u0C5C\u0C5D\u0C60\u0C61\u0C80\u0C85-\u0C8C\u0C8E-\u0C90\u0C92-\u0CA8\u0CAA-\u0CB3\u0CB5-\u0CB9\u0CBD\u0CDC-\u0CDE\u0CE0\u0CE1\u0CF1\u0CF2\u0D04-\u0D0C\u0D0E-\u0D10\u0D12-\u0D3A\u0D3D\u0D4E\u0D54-\u0D56\u0D5F-\u0D61\u0D7A-\u0D7F\u0D85-\u0D96\u0D9A-\u0DB1\u0DB3-\u0DBB\u0DBD\u0DC0-\u0DC6\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E81\u0E82\u0E84\u0E86-\u0E8A\u0E8C-\u0EA3\u0EA5\u0EA7-\u0EB0\u0EB2\u0EB3\u0EBD\u0EC0-\u0EC4\u0EC6\u0EDC-\u0EDF\u0F00\u0F40-\u0F47\u0F49-\u0F6C\u0F88-\u0F8C\u1000-\u102A\u103F\u1050-\u1055\u105A-\u105D\u1061\u1065\u1066\u106E-\u1070\u1075-\u1081\u108E\u10A0-\u10C5\u10C7\u10CD\u10D0-\u10FA\u10FC-\u1248\u124A-\u124D\u1250-\u1256\u1258\u125A-\u125D\u1260-\u1288\u128A-\u128D\u1290-\u12B0\u12B2-\u12B5\u12B8-\u12BE\u12C0\u12C2-\u12C5\u12C8-\u12D6\u12D8-\u1310\u1312-\u1315\u1318-\u135A\u1380-\u138F\u13A0-\u13F5\u13F8-\u13FD\u1401-\u166C\u166F-\u167F\u1681-\u169A\u16A0-\u16EA\u16EE-\u16F8\u1700-\u1711\u171F-\u1731\u1740-\u1751\u1760-\u176C\u176E-\u1770\u1780-\u17B3\u17D7\u17DC\u1820-\u1878\u1880-\u18A8\u18AA\u18B0-\u18F5\u1900-\u191E\u1950-\u196D\u1970-\u1974\u1980-\u19AB\u19B0-\u19C9\u1A00-\u1A16\u1A20-\u1A54\u1AA7\u1B05-\u1B33\u1B45-\u1B4C\u1B83-\u1BA0\u1BAE\u1BAF\u1BBA-\u1BE5\u1C00-\u1C23\u1C4D-\u1C4F\u1C5A-\u1C7D\u1C80-\u1C8A\u1C90-\u1CBA\u1CBD-\u1CBF\u1CE9-\u1CEC\u1CEE-\u1CF3\u1CF5\u1CF6\u1CFA\u1D00-\u1DBF\u1E00-\u1F15\u1F18-\u1F1D\u1F20-\u1F45\u1F48-\u1F4D\u1F50-\u1F57\u1F59\u1F5B\u1F5D\u1F5F-\u1F7D\u1F80-\u1FB4\u1FB6-\u1FBC\u1FBE\u1FC2-\u1FC4\u1FC6-\u1FCC\u1FD0-\u1FD3\u1FD6-\u1FDB\u1FE0-\u1FEC\u1FF2-\u1FF4\u1FF6-\u1FFC\u2071\u207F\u2090-\u209C\u2102\u2107\u210A-\u2113\u2115\u2118-\u211D\u2124\u2126\u2128\u212A-\u2139\u213C-\u213F\u2145-\u2149\u214E\u2160-\u2188\u2C00-\u2CE4\u2CEB-\u2CEE\u2CF2\u2CF3\u2D00-\u2D25\u2D27\u2D2D\u2D30-\u2D67\u2D6F\u2D80-\u2D96\u2DA0-\u2DA6\u2DA8-\u2DAE\u2DB0-\u2DB6\u2DB8-\u2DBE\u2DC0-\u2DC6\u2DC8-\u2DCE\u2DD0-\u2DD6\u2DD8-\u2DDE\u3005-\u3007\u3021-\u3029\u3031-\u3035\u3038-\u303C\u3041-\u3096\u309B-\u309F\u30A1-\u30FA\u30FC-\u30FF\u3105-\u312F\u3131-\u318E\u31A0-\u31BF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\uA48C\uA4D0-\uA4FD\uA500-\uA60C\uA610-\uA61F\uA62A\uA62B\uA640-\uA66E\uA67F-\uA69D\uA6A0-\uA6EF\uA717-\uA71F\uA722-\uA788\uA78B-\uA7DC\uA7F1-\uA801\uA803-\uA805\uA807-\uA80A\uA80C-\uA822\uA840-\uA873\uA882-\uA8B3\uA8F2-\uA8F7\uA8FB\uA8FD\uA8FE\uA90A-\uA925\uA930-\uA946\uA960-\uA97C\uA984-\uA9B2\uA9CF\uA9E0-\uA9E4\uA9E6-\uA9EF\uA9FA-\uA9FE\uAA00-\uAA28\uAA40-\uAA42\uAA44-\uAA4B\uAA60-\uAA76\uAA7A\uAA7E-\uAAAF\uAAB1\uAAB5\uAAB6\uAAB9-\uAABD\uAAC0\uAAC2\uAADB-\uAADD\uAAE0-\uAAEA\uAAF2-\uAAF4\uAB01-\uAB06\uAB09-\uAB0E\uAB11-\uAB16\uAB20-\uAB26\uAB28-\uAB2E\uAB30-\uAB5A\uAB5C-\uAB69\uAB70-\uABE2\uAC00-\uD7A3\uD7B0-\uD7C6\uD7CB-\uD7FB\uF900-\uFA6D\uFA70-\uFAD9\uFB00-\uFB06\uFB13-\uFB17\uFB1D\uFB1F-\uFB28\uFB2A-\uFB36\uFB38-\uFB3C\uFB3E\uFB40\uFB41\uFB43\uFB44\uFB46-\uFBB1\uFBD3-\uFD3D\uFD50-\uFD8F\uFD92-\uFDC7\uFDF0-\uFDFB\uFE70-\uFE74\uFE76-\uFEFC\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFBE\uFFC2-\uFFC7\uFFCA-\uFFCF\uFFD2-\uFFD7\uFFDA-\uFFDC";
var reservedWords = {
  3: "abstract boolean byte char class double enum export extends final float goto implements import int interface long native package private protected public short static super synchronized throws transient volatile",
  5: "class enum extends super const export import",
  6: "enum",
  strict: "implements interface let package private protected public static yield",
  strictBind: "eval arguments"
};
var ecma5AndLessKeywords = "break case catch continue debugger default do else finally for function if return switch throw try var while with null true false instanceof typeof void delete new in this";
var keywords$1 = {
  5: ecma5AndLessKeywords,
  "5module": ecma5AndLessKeywords + " export import",
  6: ecma5AndLessKeywords + " const class extends export import super"
};
var keywordRelationalOperator = /^in(stanceof)?$/;
var nonASCIIidentifierStart = new RegExp("[" + nonASCIIidentifierStartChars + "]");
var nonASCIIidentifier = new RegExp("[" + nonASCIIidentifierStartChars + nonASCIIidentifierChars + "]");
function isInAstralSet(code, set) {
  var pos = 65536;
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];
    if (pos > code) {
      return false;
    }
    pos += set[i + 1];
    if (pos >= code) {
      return true;
    }
  }
  return false;
}
function isIdentifierStart(code, astral) {
  if (code < 65) {
    return code === 36;
  }
  if (code < 91) {
    return true;
  }
  if (code < 97) {
    return code === 95;
  }
  if (code < 123) {
    return true;
  }
  if (code <= 65535) {
    return code >= 170 && nonASCIIidentifierStart.test(String.fromCharCode(code));
  }
  if (astral === false) {
    return false;
  }
  return isInAstralSet(code, astralIdentifierStartCodes);
}
function isIdentifierChar(code, astral) {
  if (code < 48) {
    return code === 36;
  }
  if (code < 58) {
    return true;
  }
  if (code < 65) {
    return false;
  }
  if (code < 91) {
    return true;
  }
  if (code < 97) {
    return code === 95;
  }
  if (code < 123) {
    return true;
  }
  if (code <= 65535) {
    return code >= 170 && nonASCIIidentifier.test(String.fromCharCode(code));
  }
  if (astral === false) {
    return false;
  }
  return isInAstralSet(code, astralIdentifierStartCodes) || isInAstralSet(code, astralIdentifierCodes);
}
var TokenType = function TokenType2(label, conf) {
  if (conf === void 0) conf = {};
  this.label = label;
  this.keyword = conf.keyword;
  this.beforeExpr = !!conf.beforeExpr;
  this.startsExpr = !!conf.startsExpr;
  this.isLoop = !!conf.isLoop;
  this.isAssign = !!conf.isAssign;
  this.prefix = !!conf.prefix;
  this.postfix = !!conf.postfix;
  this.binop = conf.binop || null;
  this.updateContext = null;
};
function binop(name2, prec) {
  return new TokenType(name2, { beforeExpr: true, binop: prec });
}
var beforeExpr = { beforeExpr: true };
var startsExpr = { startsExpr: true };
var keywords = {};
function kw(name2, options) {
  if (options === void 0) options = {};
  options.keyword = name2;
  return keywords[name2] = new TokenType(name2, options);
}
var types$1 = {
  num: new TokenType("num", startsExpr),
  regexp: new TokenType("regexp", startsExpr),
  string: new TokenType("string", startsExpr),
  name: new TokenType("name", startsExpr),
  privateId: new TokenType("privateId", startsExpr),
  eof: new TokenType("eof"),
  // Punctuation token types.
  bracketL: new TokenType("[", { beforeExpr: true, startsExpr: true }),
  bracketR: new TokenType("]"),
  braceL: new TokenType("{", { beforeExpr: true, startsExpr: true }),
  braceR: new TokenType("}"),
  parenL: new TokenType("(", { beforeExpr: true, startsExpr: true }),
  parenR: new TokenType(")"),
  comma: new TokenType(",", beforeExpr),
  semi: new TokenType(";", beforeExpr),
  colon: new TokenType(":", beforeExpr),
  dot: new TokenType("."),
  question: new TokenType("?", beforeExpr),
  questionDot: new TokenType("?."),
  arrow: new TokenType("=>", beforeExpr),
  template: new TokenType("template"),
  invalidTemplate: new TokenType("invalidTemplate"),
  ellipsis: new TokenType("...", beforeExpr),
  backQuote: new TokenType("`", startsExpr),
  dollarBraceL: new TokenType("${", { beforeExpr: true, startsExpr: true }),
  // Operators. These carry several kinds of properties to help the
  // parser use them properly (the presence of these properties is
  // what categorizes them as operators).
  //
  // `binop`, when present, specifies that this operator is a binary
  // operator, and will refer to its precedence.
  //
  // `prefix` and `postfix` mark the operator as a prefix or postfix
  // unary operator.
  //
  // `isAssign` marks all of `=`, `+=`, `-=` etcetera, which act as
  // binary operators with a very low precedence, that should result
  // in AssignmentExpression nodes.
  eq: new TokenType("=", { beforeExpr: true, isAssign: true }),
  assign: new TokenType("_=", { beforeExpr: true, isAssign: true }),
  incDec: new TokenType("++/--", { prefix: true, postfix: true, startsExpr: true }),
  prefix: new TokenType("!/~", { beforeExpr: true, prefix: true, startsExpr: true }),
  logicalOR: binop("||", 1),
  logicalAND: binop("&&", 2),
  bitwiseOR: binop("|", 3),
  bitwiseXOR: binop("^", 4),
  bitwiseAND: binop("&", 5),
  equality: binop("==/!=/===/!==", 6),
  relational: binop("</>/<=/>=", 7),
  bitShift: binop("<</>>/>>>", 8),
  plusMin: new TokenType("+/-", { beforeExpr: true, binop: 9, prefix: true, startsExpr: true }),
  modulo: binop("%", 10),
  star: binop("*", 10),
  slash: binop("/", 10),
  starstar: new TokenType("**", { beforeExpr: true }),
  coalesce: binop("??", 1),
  // Keyword token types.
  _break: kw("break"),
  _case: kw("case", beforeExpr),
  _catch: kw("catch"),
  _continue: kw("continue"),
  _debugger: kw("debugger"),
  _default: kw("default", beforeExpr),
  _do: kw("do", { isLoop: true, beforeExpr: true }),
  _else: kw("else", beforeExpr),
  _finally: kw("finally"),
  _for: kw("for", { isLoop: true }),
  _function: kw("function", startsExpr),
  _if: kw("if"),
  _return: kw("return", beforeExpr),
  _switch: kw("switch"),
  _throw: kw("throw", beforeExpr),
  _try: kw("try"),
  _var: kw("var"),
  _const: kw("const"),
  _while: kw("while", { isLoop: true }),
  _with: kw("with"),
  _new: kw("new", { beforeExpr: true, startsExpr: true }),
  _this: kw("this", startsExpr),
  _super: kw("super", startsExpr),
  _class: kw("class", startsExpr),
  _extends: kw("extends", beforeExpr),
  _export: kw("export"),
  _import: kw("import", startsExpr),
  _null: kw("null", startsExpr),
  _true: kw("true", startsExpr),
  _false: kw("false", startsExpr),
  _in: kw("in", { beforeExpr: true, binop: 7 }),
  _instanceof: kw("instanceof", { beforeExpr: true, binop: 7 }),
  _typeof: kw("typeof", { beforeExpr: true, prefix: true, startsExpr: true }),
  _void: kw("void", { beforeExpr: true, prefix: true, startsExpr: true }),
  _delete: kw("delete", { beforeExpr: true, prefix: true, startsExpr: true })
};
var lineBreak = /\r\n?|\n|\u2028|\u2029/;
var lineBreakG = new RegExp(lineBreak.source, "g");
function isNewLine(code) {
  return code === 10 || code === 13 || code === 8232 || code === 8233;
}
function nextLineBreak(code, from, end) {
  if (end === void 0) end = code.length;
  for (var i = from; i < end; i++) {
    var next = code.charCodeAt(i);
    if (isNewLine(next)) {
      return i < end - 1 && next === 13 && code.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
    }
  }
  return -1;
}
var nonASCIIwhitespace = /[\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
var skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g;
var ref = Object.prototype;
var hasOwnProperty = ref.hasOwnProperty;
var toString = ref.toString;
var hasOwn = Object.hasOwn || (function(obj, propName) {
  return hasOwnProperty.call(obj, propName);
});
var isArray = Array.isArray || (function(obj) {
  return toString.call(obj) === "[object Array]";
});
var regexpCache = /* @__PURE__ */ Object.create(null);
function wordsRegexp(words) {
  return regexpCache[words] || (regexpCache[words] = new RegExp("^(?:" + words.replace(/ /g, "|") + ")$"));
}
function codePointToString(code) {
  if (code <= 65535) {
    return String.fromCharCode(code);
  }
  code -= 65536;
  return String.fromCharCode((code >> 10) + 55296, (code & 1023) + 56320);
}
var loneSurrogate = /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF])/;
var Position = function Position2(line, col) {
  this.line = line;
  this.column = col;
};
Position.prototype.offset = function offset(n) {
  return new Position(this.line, this.column + n);
};
var SourceLocation = function SourceLocation2(p, start, end) {
  this.start = start;
  this.end = end;
  if (p.sourceFile !== null) {
    this.source = p.sourceFile;
  }
};
function getLineInfo(input, offset2) {
  for (var line = 1, cur = 0; ; ) {
    var nextBreak = nextLineBreak(input, cur, offset2);
    if (nextBreak < 0) {
      return new Position(line, offset2 - cur);
    }
    ++line;
    cur = nextBreak;
  }
}
var defaultOptions = {
  // `ecmaVersion` indicates the ECMAScript version to parse. Must be
  // either 3, 5, 6 (or 2015), 7 (2016), 8 (2017), 9 (2018), 10
  // (2019), 11 (2020), 12 (2021), 13 (2022), 14 (2023), or `"latest"`
  // (the latest version the library supports). This influences
  // support for strict mode, the set of reserved words, and support
  // for new syntax features.
  ecmaVersion: null,
  // `sourceType` indicates the mode the code should be parsed in.
  // Can be either `"script"`, `"module"` or `"commonjs"`. This influences global
  // strict mode and parsing of `import` and `export` declarations.
  sourceType: "script",
  // `onInsertedSemicolon` can be a callback that will be called when
  // a semicolon is automatically inserted. It will be passed the
  // position of the inserted semicolon as an offset, and if
  // `locations` is enabled, it is given the location as a `{line,
  // column}` object as second argument.
  onInsertedSemicolon: null,
  // `onTrailingComma` is similar to `onInsertedSemicolon`, but for
  // trailing commas.
  onTrailingComma: null,
  // By default, reserved words are only enforced if ecmaVersion >= 5.
  // Set `allowReserved` to a boolean value to explicitly turn this on
  // an off. When this option has the value "never", reserved words
  // and keywords can also not be used as property names.
  allowReserved: null,
  // When enabled, a return at the top level is not considered an
  // error.
  allowReturnOutsideFunction: false,
  // When enabled, import/export statements are not constrained to
  // appearing at the top of the program, and an import.meta expression
  // in a script isn't considered an error.
  allowImportExportEverywhere: false,
  // By default, await identifiers are allowed to appear at the top-level scope only if ecmaVersion >= 2022.
  // When enabled, await identifiers are allowed to appear at the top-level scope,
  // but they are still not allowed in non-async functions.
  allowAwaitOutsideFunction: null,
  // When enabled, super identifiers are not constrained to
  // appearing in methods and do not raise an error when they appear elsewhere.
  allowSuperOutsideMethod: null,
  // When enabled, hashbang directive in the beginning of file is
  // allowed and treated as a line comment. Enabled by default when
  // `ecmaVersion` >= 2023.
  allowHashBang: false,
  // By default, the parser will verify that private properties are
  // only used in places where they are valid and have been declared.
  // Set this to false to turn such checks off.
  checkPrivateFields: true,
  // When `locations` is on, `loc` properties holding objects with
  // `start` and `end` properties in `{line, column}` form (with
  // line being 1-based and column 0-based) will be attached to the
  // nodes.
  locations: false,
  // A function can be passed as `onToken` option, which will
  // cause Acorn to call that function with object in the same
  // format as tokens returned from `tokenizer().getToken()`. Note
  // that you are not allowed to call the parser from the
  // callback—that will corrupt its internal state.
  onToken: null,
  // A function can be passed as `onComment` option, which will
  // cause Acorn to call that function with `(block, text, start,
  // end)` parameters whenever a comment is skipped. `block` is a
  // boolean indicating whether this is a block (`/* */`) comment,
  // `text` is the content of the comment, and `start` and `end` are
  // character offsets that denote the start and end of the comment.
  // When the `locations` option is on, two more parameters are
  // passed, the full `{line, column}` locations of the start and
  // end of the comments. Note that you are not allowed to call the
  // parser from the callback—that will corrupt its internal state.
  // When this option has an array as value, objects representing the
  // comments are pushed to it.
  onComment: null,
  // Nodes have their start and end characters offsets recorded in
  // `start` and `end` properties (directly on the node, rather than
  // the `loc` object, which holds line/column data. To also add a
  // [semi-standardized][range] `range` property holding a `[start,
  // end]` array with the same numbers, set the `ranges` option to
  // `true`.
  //
  // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
  ranges: false,
  // It is possible to parse multiple files into a single AST by
  // passing the tree produced by parsing the first file as
  // `program` option in subsequent parses. This will add the
  // toplevel forms of the parsed file to the `Program` (top) node
  // of an existing parse tree.
  program: null,
  // When `locations` is on, you can pass this to record the source
  // file in every node's `loc` object.
  sourceFile: null,
  // This value, if given, is stored in every node, whether
  // `locations` is on or off.
  directSourceFile: null,
  // When enabled, parenthesized expressions are represented by
  // (non-standard) ParenthesizedExpression nodes
  preserveParens: false
};
var warnedAboutEcmaVersion = false;
function getOptions(opts) {
  var options = {};
  for (var opt in defaultOptions) {
    options[opt] = opts && hasOwn(opts, opt) ? opts[opt] : defaultOptions[opt];
  }
  if (options.ecmaVersion === "latest") {
    options.ecmaVersion = 1e8;
  } else if (options.ecmaVersion == null) {
    if (!warnedAboutEcmaVersion && typeof console === "object" && console.warn) {
      warnedAboutEcmaVersion = true;
      console.warn("Since Acorn 8.0.0, options.ecmaVersion is required.\nDefaulting to 2020, but this will stop working in the future.");
    }
    options.ecmaVersion = 11;
  } else if (options.ecmaVersion >= 2015) {
    options.ecmaVersion -= 2009;
  }
  if (options.allowReserved == null) {
    options.allowReserved = options.ecmaVersion < 5;
  }
  if (!opts || opts.allowHashBang == null) {
    options.allowHashBang = options.ecmaVersion >= 14;
  }
  if (isArray(options.onToken)) {
    var tokens = options.onToken;
    options.onToken = function(token) {
      return tokens.push(token);
    };
  }
  if (isArray(options.onComment)) {
    options.onComment = pushComment(options, options.onComment);
  }
  if (options.sourceType === "commonjs" && options.allowAwaitOutsideFunction) {
    throw new Error("Cannot use allowAwaitOutsideFunction with sourceType: commonjs");
  }
  return options;
}
function pushComment(options, array2) {
  return function(block, text, start, end, startLoc, endLoc) {
    var comment = {
      type: block ? "Block" : "Line",
      value: text,
      start,
      end
    };
    if (options.locations) {
      comment.loc = new SourceLocation(this, startLoc, endLoc);
    }
    if (options.ranges) {
      comment.range = [start, end];
    }
    array2.push(comment);
  };
}
var SCOPE_TOP = 1;
var SCOPE_FUNCTION = 2;
var SCOPE_ASYNC = 4;
var SCOPE_GENERATOR = 8;
var SCOPE_ARROW = 16;
var SCOPE_SIMPLE_CATCH = 32;
var SCOPE_SUPER = 64;
var SCOPE_DIRECT_SUPER = 128;
var SCOPE_CLASS_STATIC_BLOCK = 256;
var SCOPE_CLASS_FIELD_INIT = 512;
var SCOPE_SWITCH = 1024;
var SCOPE_VAR = SCOPE_TOP | SCOPE_FUNCTION | SCOPE_CLASS_STATIC_BLOCK;
function functionFlags(async, generator) {
  return SCOPE_FUNCTION | (async ? SCOPE_ASYNC : 0) | (generator ? SCOPE_GENERATOR : 0);
}
var BIND_NONE = 0;
var BIND_VAR = 1;
var BIND_LEXICAL = 2;
var BIND_FUNCTION = 3;
var BIND_SIMPLE_CATCH = 4;
var BIND_OUTSIDE = 5;
var Parser = function Parser2(options, input, startPos) {
  this.options = options = getOptions(options);
  this.sourceFile = options.sourceFile;
  this.keywords = wordsRegexp(keywords$1[options.ecmaVersion >= 6 ? 6 : options.sourceType === "module" ? "5module" : 5]);
  var reserved = "";
  if (options.allowReserved !== true) {
    reserved = reservedWords[options.ecmaVersion >= 6 ? 6 : options.ecmaVersion === 5 ? 5 : 3];
    if (options.sourceType === "module") {
      reserved += " await";
    }
  }
  this.reservedWords = wordsRegexp(reserved);
  var reservedStrict = (reserved ? reserved + " " : "") + reservedWords.strict;
  this.reservedWordsStrict = wordsRegexp(reservedStrict);
  this.reservedWordsStrictBind = wordsRegexp(reservedStrict + " " + reservedWords.strictBind);
  this.input = String(input);
  this.containsEsc = false;
  if (startPos) {
    this.pos = startPos;
    this.lineStart = this.input.lastIndexOf("\n", startPos - 1) + 1;
    this.curLine = this.input.slice(0, this.lineStart).split(lineBreak).length;
  } else {
    this.pos = this.lineStart = 0;
    this.curLine = 1;
  }
  this.type = types$1.eof;
  this.value = null;
  this.start = this.end = this.pos;
  this.startLoc = this.endLoc = this.curPosition();
  this.lastTokEndLoc = this.lastTokStartLoc = null;
  this.lastTokStart = this.lastTokEnd = this.pos;
  this.context = this.initialContext();
  this.exprAllowed = true;
  this.inModule = options.sourceType === "module";
  this.strict = this.inModule || this.strictDirective(this.pos);
  this.potentialArrowAt = -1;
  this.potentialArrowInForAwait = false;
  this.yieldPos = this.awaitPos = this.awaitIdentPos = 0;
  this.labels = [];
  this.undefinedExports = /* @__PURE__ */ Object.create(null);
  if (this.pos === 0 && options.allowHashBang && this.input.slice(0, 2) === "#!") {
    this.skipLineComment(2);
  }
  this.scopeStack = [];
  this.enterScope(
    this.options.sourceType === "commonjs" ? SCOPE_FUNCTION : SCOPE_TOP
  );
  this.regexpState = null;
  this.privateNameStack = [];
};
var prototypeAccessors = { inFunction: { configurable: true }, inGenerator: { configurable: true }, inAsync: { configurable: true }, canAwait: { configurable: true }, allowReturn: { configurable: true }, allowSuper: { configurable: true }, allowDirectSuper: { configurable: true }, treatFunctionsAsVar: { configurable: true }, allowNewDotTarget: { configurable: true }, allowUsing: { configurable: true }, inClassStaticBlock: { configurable: true } };
Parser.prototype.parse = function parse() {
  var node2 = this.options.program || this.startNode();
  this.nextToken();
  return this.parseTopLevel(node2);
};
prototypeAccessors.inFunction.get = function() {
  return (this.currentVarScope().flags & SCOPE_FUNCTION) > 0;
};
prototypeAccessors.inGenerator.get = function() {
  return (this.currentVarScope().flags & SCOPE_GENERATOR) > 0;
};
prototypeAccessors.inAsync.get = function() {
  return (this.currentVarScope().flags & SCOPE_ASYNC) > 0;
};
prototypeAccessors.canAwait.get = function() {
  for (var i = this.scopeStack.length - 1; i >= 0; i--) {
    var ref2 = this.scopeStack[i];
    var flags = ref2.flags;
    if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT)) {
      return false;
    }
    if (flags & SCOPE_FUNCTION) {
      return (flags & SCOPE_ASYNC) > 0;
    }
  }
  return this.inModule && this.options.ecmaVersion >= 13 || this.options.allowAwaitOutsideFunction;
};
prototypeAccessors.allowReturn.get = function() {
  if (this.inFunction) {
    return true;
  }
  if (this.options.allowReturnOutsideFunction && this.currentVarScope().flags & SCOPE_TOP) {
    return true;
  }
  return false;
};
prototypeAccessors.allowSuper.get = function() {
  var ref2 = this.currentThisScope();
  var flags = ref2.flags;
  return (flags & SCOPE_SUPER) > 0 || this.options.allowSuperOutsideMethod;
};
prototypeAccessors.allowDirectSuper.get = function() {
  return (this.currentThisScope().flags & SCOPE_DIRECT_SUPER) > 0;
};
prototypeAccessors.treatFunctionsAsVar.get = function() {
  return this.treatFunctionsAsVarInScope(this.currentScope());
};
prototypeAccessors.allowNewDotTarget.get = function() {
  for (var i = this.scopeStack.length - 1; i >= 0; i--) {
    var ref2 = this.scopeStack[i];
    var flags = ref2.flags;
    if (flags & (SCOPE_CLASS_STATIC_BLOCK | SCOPE_CLASS_FIELD_INIT) || flags & SCOPE_FUNCTION && !(flags & SCOPE_ARROW)) {
      return true;
    }
  }
  return false;
};
prototypeAccessors.allowUsing.get = function() {
  var ref2 = this.currentScope();
  var flags = ref2.flags;
  if (flags & SCOPE_SWITCH) {
    return false;
  }
  if (!this.inModule && flags & SCOPE_TOP) {
    return false;
  }
  return true;
};
prototypeAccessors.inClassStaticBlock.get = function() {
  return (this.currentVarScope().flags & SCOPE_CLASS_STATIC_BLOCK) > 0;
};
Parser.extend = function extend() {
  var plugins = [], len = arguments.length;
  while (len--) plugins[len] = arguments[len];
  var cls = this;
  for (var i = 0; i < plugins.length; i++) {
    cls = plugins[i](cls);
  }
  return cls;
};
Parser.parse = function parse2(input, options) {
  return new this(options, input).parse();
};
Parser.parseExpressionAt = function parseExpressionAt(input, pos, options) {
  var parser = new this(options, input, pos);
  parser.nextToken();
  return parser.parseExpression();
};
Parser.tokenizer = function tokenizer(input, options) {
  return new this(options, input);
};
Object.defineProperties(Parser.prototype, prototypeAccessors);
var pp$9 = Parser.prototype;
var literal = /^(?:'((?:\\[^]|[^'\\])*?)'|"((?:\\[^]|[^"\\])*?)")/;
pp$9.strictDirective = function(start) {
  if (this.options.ecmaVersion < 5) {
    return false;
  }
  for (; ; ) {
    skipWhiteSpace.lastIndex = start;
    start += skipWhiteSpace.exec(this.input)[0].length;
    var match = literal.exec(this.input.slice(start));
    if (!match) {
      return false;
    }
    if ((match[1] || match[2]) === "use strict") {
      skipWhiteSpace.lastIndex = start + match[0].length;
      var spaceAfter = skipWhiteSpace.exec(this.input), end = spaceAfter.index + spaceAfter[0].length;
      var next = this.input.charAt(end);
      return next === ";" || next === "}" || lineBreak.test(spaceAfter[0]) && !(/[(`.[+\-/*%<>=,?^&]/.test(next) || next === "!" && this.input.charAt(end + 1) === "=");
    }
    start += match[0].length;
    skipWhiteSpace.lastIndex = start;
    start += skipWhiteSpace.exec(this.input)[0].length;
    if (this.input[start] === ";") {
      start++;
    }
  }
};
pp$9.eat = function(type) {
  if (this.type === type) {
    this.next();
    return true;
  } else {
    return false;
  }
};
pp$9.isContextual = function(name2) {
  return this.type === types$1.name && this.value === name2 && !this.containsEsc;
};
pp$9.eatContextual = function(name2) {
  if (!this.isContextual(name2)) {
    return false;
  }
  this.next();
  return true;
};
pp$9.expectContextual = function(name2) {
  if (!this.eatContextual(name2)) {
    this.unexpected();
  }
};
pp$9.canInsertSemicolon = function() {
  return this.type === types$1.eof || this.type === types$1.braceR || lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
};
pp$9.insertSemicolon = function() {
  if (this.canInsertSemicolon()) {
    if (this.options.onInsertedSemicolon) {
      this.options.onInsertedSemicolon(this.lastTokEnd, this.lastTokEndLoc);
    }
    return true;
  }
};
pp$9.semicolon = function() {
  if (!this.eat(types$1.semi) && !this.insertSemicolon()) {
    this.unexpected();
  }
};
pp$9.afterTrailingComma = function(tokType, notNext) {
  if (this.type === tokType) {
    if (this.options.onTrailingComma) {
      this.options.onTrailingComma(this.lastTokStart, this.lastTokStartLoc);
    }
    if (!notNext) {
      this.next();
    }
    return true;
  }
};
pp$9.expect = function(type) {
  this.eat(type) || this.unexpected();
};
pp$9.unexpected = function(pos) {
  this.raise(pos != null ? pos : this.start, "Unexpected token");
};
var DestructuringErrors = function DestructuringErrors2() {
  this.shorthandAssign = this.trailingComma = this.parenthesizedAssign = this.parenthesizedBind = this.doubleProto = -1;
};
pp$9.checkPatternErrors = function(refDestructuringErrors, isAssign) {
  if (!refDestructuringErrors) {
    return;
  }
  if (refDestructuringErrors.trailingComma > -1) {
    this.raiseRecoverable(refDestructuringErrors.trailingComma, "Comma is not permitted after the rest element");
  }
  var parens = isAssign ? refDestructuringErrors.parenthesizedAssign : refDestructuringErrors.parenthesizedBind;
  if (parens > -1) {
    this.raiseRecoverable(parens, isAssign ? "Assigning to rvalue" : "Parenthesized pattern");
  }
};
pp$9.checkExpressionErrors = function(refDestructuringErrors, andThrow) {
  if (!refDestructuringErrors) {
    return false;
  }
  var shorthandAssign = refDestructuringErrors.shorthandAssign;
  var doubleProto = refDestructuringErrors.doubleProto;
  if (!andThrow) {
    return shorthandAssign >= 0 || doubleProto >= 0;
  }
  if (shorthandAssign >= 0) {
    this.raise(shorthandAssign, "Shorthand property assignments are valid only in destructuring patterns");
  }
  if (doubleProto >= 0) {
    this.raiseRecoverable(doubleProto, "Redefinition of __proto__ property");
  }
};
pp$9.checkYieldAwaitInDefaultParams = function() {
  if (this.yieldPos && (!this.awaitPos || this.yieldPos < this.awaitPos)) {
    this.raise(this.yieldPos, "Yield expression cannot be a default value");
  }
  if (this.awaitPos) {
    this.raise(this.awaitPos, "Await expression cannot be a default value");
  }
};
pp$9.isSimpleAssignTarget = function(expr2) {
  if (expr2.type === "ParenthesizedExpression") {
    return this.isSimpleAssignTarget(expr2.expression);
  }
  return expr2.type === "Identifier" || expr2.type === "MemberExpression";
};
var pp$8 = Parser.prototype;
pp$8.parseTopLevel = function(node2) {
  var exports = /* @__PURE__ */ Object.create(null);
  if (!node2.body) {
    node2.body = [];
  }
  while (this.type !== types$1.eof) {
    var stmt2 = this.parseStatement(null, true, exports);
    node2.body.push(stmt2);
  }
  if (this.inModule) {
    for (var i = 0, list = Object.keys(this.undefinedExports); i < list.length; i += 1) {
      var name2 = list[i];
      this.raiseRecoverable(this.undefinedExports[name2].start, "Export '" + name2 + "' is not defined");
    }
  }
  this.adaptDirectivePrologue(node2.body);
  this.next();
  node2.sourceType = this.options.sourceType === "commonjs" ? "script" : this.options.sourceType;
  return this.finishNode(node2, "Program");
};
var loopLabel = { kind: "loop" };
var switchLabel = { kind: "switch" };
pp$8.isLet = function(context) {
  if (this.options.ecmaVersion < 6 || !this.isContextual("let")) {
    return false;
  }
  skipWhiteSpace.lastIndex = this.pos;
  var skip = skipWhiteSpace.exec(this.input);
  var next = this.pos + skip[0].length, nextCh = this.fullCharCodeAt(next);
  if (nextCh === 91 || nextCh === 92) {
    return true;
  }
  if (context) {
    return false;
  }
  if (nextCh === 123) {
    return true;
  }
  if (isIdentifierStart(nextCh)) {
    var start = next;
    do {
      next += nextCh <= 65535 ? 1 : 2;
    } while (isIdentifierChar(nextCh = this.fullCharCodeAt(next)));
    if (nextCh === 92) {
      return true;
    }
    var ident = this.input.slice(start, next);
    if (!keywordRelationalOperator.test(ident)) {
      return true;
    }
  }
  return false;
};
pp$8.isAsyncFunction = function() {
  if (this.options.ecmaVersion < 8 || !this.isContextual("async")) {
    return false;
  }
  skipWhiteSpace.lastIndex = this.pos;
  var skip = skipWhiteSpace.exec(this.input);
  var next = this.pos + skip[0].length, after;
  return !lineBreak.test(this.input.slice(this.pos, next)) && this.input.slice(next, next + 8) === "function" && (next + 8 === this.input.length || !(isIdentifierChar(after = this.fullCharCodeAt(next + 8)) || after === 92));
};
pp$8.isUsingKeyword = function(isAwaitUsing, isFor) {
  if (this.options.ecmaVersion < 17 || !this.isContextual(isAwaitUsing ? "await" : "using")) {
    return false;
  }
  skipWhiteSpace.lastIndex = this.pos;
  var skip = skipWhiteSpace.exec(this.input);
  var next = this.pos + skip[0].length;
  if (lineBreak.test(this.input.slice(this.pos, next))) {
    return false;
  }
  if (isAwaitUsing) {
    var usingEndPos = next + 5, after;
    if (this.input.slice(next, usingEndPos) !== "using" || usingEndPos === this.input.length || isIdentifierChar(after = this.fullCharCodeAt(usingEndPos)) || after === 92) {
      return false;
    }
    skipWhiteSpace.lastIndex = usingEndPos;
    var skipAfterUsing = skipWhiteSpace.exec(this.input);
    next = usingEndPos + skipAfterUsing[0].length;
    if (skipAfterUsing && lineBreak.test(this.input.slice(usingEndPos, next))) {
      return false;
    }
  }
  var ch = this.fullCharCodeAt(next);
  if (!isIdentifierStart(ch) && ch !== 92) {
    return false;
  }
  var idStart = next;
  do {
    next += ch <= 65535 ? 1 : 2;
  } while (isIdentifierChar(ch = this.fullCharCodeAt(next)));
  if (ch === 92) {
    return true;
  }
  var id2 = this.input.slice(idStart, next);
  if (keywordRelationalOperator.test(id2) || isFor && id2 === "of") {
    return false;
  }
  return true;
};
pp$8.isAwaitUsing = function(isFor) {
  return this.isUsingKeyword(true, isFor);
};
pp$8.isUsing = function(isFor) {
  return this.isUsingKeyword(false, isFor);
};
pp$8.parseStatement = function(context, topLevel, exports) {
  var starttype = this.type, node2 = this.startNode(), kind;
  if (this.isLet(context)) {
    starttype = types$1._var;
    kind = "let";
  }
  switch (starttype) {
    case types$1._break:
    case types$1._continue:
      return this.parseBreakContinueStatement(node2, starttype.keyword);
    case types$1._debugger:
      return this.parseDebuggerStatement(node2);
    case types$1._do:
      return this.parseDoStatement(node2);
    case types$1._for:
      return this.parseForStatement(node2);
    case types$1._function:
      if (context && (this.strict || context !== "if" && context !== "label") && this.options.ecmaVersion >= 6) {
        this.unexpected();
      }
      return this.parseFunctionStatement(node2, false, !context);
    case types$1._class:
      if (context) {
        this.unexpected();
      }
      return this.parseClass(node2, true);
    case types$1._if:
      return this.parseIfStatement(node2);
    case types$1._return:
      return this.parseReturnStatement(node2);
    case types$1._switch:
      return this.parseSwitchStatement(node2);
    case types$1._throw:
      return this.parseThrowStatement(node2);
    case types$1._try:
      return this.parseTryStatement(node2);
    case types$1._const:
    case types$1._var:
      kind = kind || this.value;
      if (context && kind !== "var") {
        this.unexpected();
      }
      return this.parseVarStatement(node2, kind);
    case types$1._while:
      return this.parseWhileStatement(node2);
    case types$1._with:
      return this.parseWithStatement(node2);
    case types$1.braceL:
      return this.parseBlock(true, node2);
    case types$1.semi:
      return this.parseEmptyStatement(node2);
    case types$1._export:
    case types$1._import:
      if (this.options.ecmaVersion > 10 && starttype === types$1._import) {
        skipWhiteSpace.lastIndex = this.pos;
        var skip = skipWhiteSpace.exec(this.input);
        var next = this.pos + skip[0].length, nextCh = this.input.charCodeAt(next);
        if (nextCh === 40 || nextCh === 46) {
          return this.parseExpressionStatement(node2, this.parseExpression());
        }
      }
      if (!this.options.allowImportExportEverywhere) {
        if (!topLevel) {
          this.raise(this.start, "'import' and 'export' may only appear at the top level");
        }
        if (!this.inModule) {
          this.raise(this.start, "'import' and 'export' may appear only with 'sourceType: module'");
        }
      }
      return starttype === types$1._import ? this.parseImport(node2) : this.parseExport(node2, exports);
    // If the statement does not start with a statement keyword or a
    // brace, it's an ExpressionStatement or LabeledStatement. We
    // simply start parsing an expression, and afterwards, if the
    // next token is a colon and the expression was a simple
    // Identifier node, we switch to interpreting it as a label.
    default:
      if (this.isAsyncFunction()) {
        if (context) {
          this.unexpected();
        }
        this.next();
        return this.parseFunctionStatement(node2, true, !context);
      }
      var usingKind = this.isAwaitUsing(false) ? "await using" : this.isUsing(false) ? "using" : null;
      if (usingKind) {
        if (!this.allowUsing) {
          this.raise(this.start, "Using declaration cannot appear in the top level when source type is `script` or in the bare case statement");
        }
        if (usingKind === "await using") {
          if (!this.canAwait) {
            this.raise(this.start, "Await using cannot appear outside of async function");
          }
          this.next();
        }
        this.next();
        this.parseVar(node2, false, usingKind);
        this.semicolon();
        return this.finishNode(node2, "VariableDeclaration");
      }
      var maybeName = this.value, expr2 = this.parseExpression();
      if (starttype === types$1.name && expr2.type === "Identifier" && this.eat(types$1.colon)) {
        return this.parseLabeledStatement(node2, maybeName, expr2, context);
      } else {
        return this.parseExpressionStatement(node2, expr2);
      }
  }
};
pp$8.parseBreakContinueStatement = function(node2, keyword) {
  var isBreak = keyword === "break";
  this.next();
  if (this.eat(types$1.semi) || this.insertSemicolon()) {
    node2.label = null;
  } else if (this.type !== types$1.name) {
    this.unexpected();
  } else {
    node2.label = this.parseIdent();
    this.semicolon();
  }
  var i = 0;
  for (; i < this.labels.length; ++i) {
    var lab = this.labels[i];
    if (node2.label == null || lab.name === node2.label.name) {
      if (lab.kind != null && (isBreak || lab.kind === "loop")) {
        break;
      }
      if (node2.label && isBreak) {
        break;
      }
    }
  }
  if (i === this.labels.length) {
    this.raise(node2.start, "Unsyntactic " + keyword);
  }
  return this.finishNode(node2, isBreak ? "BreakStatement" : "ContinueStatement");
};
pp$8.parseDebuggerStatement = function(node2) {
  this.next();
  this.semicolon();
  return this.finishNode(node2, "DebuggerStatement");
};
pp$8.parseDoStatement = function(node2) {
  this.next();
  this.labels.push(loopLabel);
  node2.body = this.parseStatement("do");
  this.labels.pop();
  this.expect(types$1._while);
  node2.test = this.parseParenExpression();
  if (this.options.ecmaVersion >= 6) {
    this.eat(types$1.semi);
  } else {
    this.semicolon();
  }
  return this.finishNode(node2, "DoWhileStatement");
};
pp$8.parseForStatement = function(node2) {
  this.next();
  var awaitAt = this.options.ecmaVersion >= 9 && this.canAwait && this.eatContextual("await") ? this.lastTokStart : -1;
  this.labels.push(loopLabel);
  this.enterScope(0);
  this.expect(types$1.parenL);
  if (this.type === types$1.semi) {
    if (awaitAt > -1) {
      this.unexpected(awaitAt);
    }
    return this.parseFor(node2, null);
  }
  var isLet = this.isLet();
  if (this.type === types$1._var || this.type === types$1._const || isLet) {
    var init$1 = this.startNode(), kind = isLet ? "let" : this.value;
    this.next();
    this.parseVar(init$1, true, kind);
    this.finishNode(init$1, "VariableDeclaration");
    return this.parseForAfterInit(node2, init$1, awaitAt);
  }
  var startsWithLet = this.isContextual("let"), isForOf = false;
  var usingKind = this.isUsing(true) ? "using" : this.isAwaitUsing(true) ? "await using" : null;
  if (usingKind) {
    var init$2 = this.startNode();
    this.next();
    if (usingKind === "await using") {
      if (!this.canAwait) {
        this.raise(this.start, "Await using cannot appear outside of async function");
      }
      this.next();
    }
    this.parseVar(init$2, true, usingKind);
    this.finishNode(init$2, "VariableDeclaration");
    return this.parseForAfterInit(node2, init$2, awaitAt);
  }
  var containsEsc = this.containsEsc;
  var refDestructuringErrors = new DestructuringErrors();
  var initPos = this.start;
  var init = awaitAt > -1 ? this.parseExprSubscripts(refDestructuringErrors, "await") : this.parseExpression(true, refDestructuringErrors);
  if (this.type === types$1._in || (isForOf = this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
    if (awaitAt > -1) {
      if (this.type === types$1._in) {
        this.unexpected(awaitAt);
      }
      node2.await = true;
    } else if (isForOf && this.options.ecmaVersion >= 8) {
      if (init.start === initPos && !containsEsc && init.type === "Identifier" && init.name === "async") {
        this.unexpected();
      } else if (this.options.ecmaVersion >= 9) {
        node2.await = false;
      }
    }
    if (startsWithLet && isForOf) {
      this.raise(init.start, "The left-hand side of a for-of loop may not start with 'let'.");
    }
    this.toAssignable(init, false, refDestructuringErrors);
    this.checkLValPattern(init);
    return this.parseForIn(node2, init);
  } else {
    this.checkExpressionErrors(refDestructuringErrors, true);
  }
  if (awaitAt > -1) {
    this.unexpected(awaitAt);
  }
  return this.parseFor(node2, init);
};
pp$8.parseForAfterInit = function(node2, init, awaitAt) {
  if ((this.type === types$1._in || this.options.ecmaVersion >= 6 && this.isContextual("of")) && init.declarations.length === 1) {
    if (this.options.ecmaVersion >= 9) {
      if (this.type === types$1._in) {
        if (awaitAt > -1) {
          this.unexpected(awaitAt);
        }
      } else {
        node2.await = awaitAt > -1;
      }
    }
    return this.parseForIn(node2, init);
  }
  if (awaitAt > -1) {
    this.unexpected(awaitAt);
  }
  return this.parseFor(node2, init);
};
pp$8.parseFunctionStatement = function(node2, isAsync, declarationPosition) {
  this.next();
  return this.parseFunction(node2, FUNC_STATEMENT | (declarationPosition ? 0 : FUNC_HANGING_STATEMENT), false, isAsync);
};
pp$8.parseIfStatement = function(node2) {
  this.next();
  node2.test = this.parseParenExpression();
  node2.consequent = this.parseStatement("if");
  node2.alternate = this.eat(types$1._else) ? this.parseStatement("if") : null;
  return this.finishNode(node2, "IfStatement");
};
pp$8.parseReturnStatement = function(node2) {
  if (!this.allowReturn) {
    this.raise(this.start, "'return' outside of function");
  }
  this.next();
  if (this.eat(types$1.semi) || this.insertSemicolon()) {
    node2.argument = null;
  } else {
    node2.argument = this.parseExpression();
    this.semicolon();
  }
  return this.finishNode(node2, "ReturnStatement");
};
pp$8.parseSwitchStatement = function(node2) {
  this.next();
  node2.discriminant = this.parseParenExpression();
  node2.cases = [];
  this.expect(types$1.braceL);
  this.labels.push(switchLabel);
  this.enterScope(SCOPE_SWITCH);
  var cur;
  for (var sawDefault = false; this.type !== types$1.braceR; ) {
    if (this.type === types$1._case || this.type === types$1._default) {
      var isCase = this.type === types$1._case;
      if (cur) {
        this.finishNode(cur, "SwitchCase");
      }
      node2.cases.push(cur = this.startNode());
      cur.consequent = [];
      this.next();
      if (isCase) {
        cur.test = this.parseExpression();
      } else {
        if (sawDefault) {
          this.raiseRecoverable(this.lastTokStart, "Multiple default clauses");
        }
        sawDefault = true;
        cur.test = null;
      }
      this.expect(types$1.colon);
    } else {
      if (!cur) {
        this.unexpected();
      }
      cur.consequent.push(this.parseStatement(null));
    }
  }
  this.exitScope();
  if (cur) {
    this.finishNode(cur, "SwitchCase");
  }
  this.next();
  this.labels.pop();
  return this.finishNode(node2, "SwitchStatement");
};
pp$8.parseThrowStatement = function(node2) {
  this.next();
  if (lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) {
    this.raise(this.lastTokEnd, "Illegal newline after throw");
  }
  node2.argument = this.parseExpression();
  this.semicolon();
  return this.finishNode(node2, "ThrowStatement");
};
var empty$1 = [];
pp$8.parseCatchClauseParam = function() {
  var param = this.parseBindingAtom();
  var simple = param.type === "Identifier";
  this.enterScope(simple ? SCOPE_SIMPLE_CATCH : 0);
  this.checkLValPattern(param, simple ? BIND_SIMPLE_CATCH : BIND_LEXICAL);
  this.expect(types$1.parenR);
  return param;
};
pp$8.parseTryStatement = function(node2) {
  this.next();
  node2.block = this.parseBlock();
  node2.handler = null;
  if (this.type === types$1._catch) {
    var clause = this.startNode();
    this.next();
    if (this.eat(types$1.parenL)) {
      clause.param = this.parseCatchClauseParam();
    } else {
      if (this.options.ecmaVersion < 10) {
        this.unexpected();
      }
      clause.param = null;
      this.enterScope(0);
    }
    clause.body = this.parseBlock(false);
    this.exitScope();
    node2.handler = this.finishNode(clause, "CatchClause");
  }
  node2.finalizer = this.eat(types$1._finally) ? this.parseBlock() : null;
  if (!node2.handler && !node2.finalizer) {
    this.raise(node2.start, "Missing catch or finally clause");
  }
  return this.finishNode(node2, "TryStatement");
};
pp$8.parseVarStatement = function(node2, kind, allowMissingInitializer) {
  this.next();
  this.parseVar(node2, false, kind, allowMissingInitializer);
  this.semicolon();
  return this.finishNode(node2, "VariableDeclaration");
};
pp$8.parseWhileStatement = function(node2) {
  this.next();
  node2.test = this.parseParenExpression();
  this.labels.push(loopLabel);
  node2.body = this.parseStatement("while");
  this.labels.pop();
  return this.finishNode(node2, "WhileStatement");
};
pp$8.parseWithStatement = function(node2) {
  if (this.strict) {
    this.raise(this.start, "'with' in strict mode");
  }
  this.next();
  node2.object = this.parseParenExpression();
  node2.body = this.parseStatement("with");
  return this.finishNode(node2, "WithStatement");
};
pp$8.parseEmptyStatement = function(node2) {
  this.next();
  return this.finishNode(node2, "EmptyStatement");
};
pp$8.parseLabeledStatement = function(node2, maybeName, expr2, context) {
  for (var i$1 = 0, list = this.labels; i$1 < list.length; i$1 += 1) {
    var label = list[i$1];
    if (label.name === maybeName) {
      this.raise(expr2.start, "Label '" + maybeName + "' is already declared");
    }
  }
  var kind = this.type.isLoop ? "loop" : this.type === types$1._switch ? "switch" : null;
  for (var i = this.labels.length - 1; i >= 0; i--) {
    var label$1 = this.labels[i];
    if (label$1.statementStart === node2.start) {
      label$1.statementStart = this.start;
      label$1.kind = kind;
    } else {
      break;
    }
  }
  this.labels.push({ name: maybeName, kind, statementStart: this.start });
  node2.body = this.parseStatement(context ? context.indexOf("label") === -1 ? context + "label" : context : "label");
  this.labels.pop();
  node2.label = expr2;
  return this.finishNode(node2, "LabeledStatement");
};
pp$8.parseExpressionStatement = function(node2, expr2) {
  node2.expression = expr2;
  this.semicolon();
  return this.finishNode(node2, "ExpressionStatement");
};
pp$8.parseBlock = function(createNewLexicalScope, node2, exitStrict) {
  if (createNewLexicalScope === void 0) createNewLexicalScope = true;
  if (node2 === void 0) node2 = this.startNode();
  node2.body = [];
  this.expect(types$1.braceL);
  if (createNewLexicalScope) {
    this.enterScope(0);
  }
  while (this.type !== types$1.braceR) {
    var stmt2 = this.parseStatement(null);
    node2.body.push(stmt2);
  }
  if (exitStrict) {
    this.strict = false;
  }
  this.next();
  if (createNewLexicalScope) {
    this.exitScope();
  }
  return this.finishNode(node2, "BlockStatement");
};
pp$8.parseFor = function(node2, init) {
  node2.init = init;
  this.expect(types$1.semi);
  node2.test = this.type === types$1.semi ? null : this.parseExpression();
  this.expect(types$1.semi);
  node2.update = this.type === types$1.parenR ? null : this.parseExpression();
  this.expect(types$1.parenR);
  node2.body = this.parseStatement("for");
  this.exitScope();
  this.labels.pop();
  return this.finishNode(node2, "ForStatement");
};
pp$8.parseForIn = function(node2, init) {
  var isForIn = this.type === types$1._in;
  this.next();
  if (init.type === "VariableDeclaration" && init.declarations[0].init != null && (!isForIn || this.options.ecmaVersion < 8 || this.strict || init.kind !== "var" || init.declarations[0].id.type !== "Identifier")) {
    this.raise(
      init.start,
      (isForIn ? "for-in" : "for-of") + " loop variable declaration may not have an initializer"
    );
  }
  node2.left = init;
  node2.right = isForIn ? this.parseExpression() : this.parseMaybeAssign();
  this.expect(types$1.parenR);
  node2.body = this.parseStatement("for");
  this.exitScope();
  this.labels.pop();
  return this.finishNode(node2, isForIn ? "ForInStatement" : "ForOfStatement");
};
pp$8.parseVar = function(node2, isFor, kind, allowMissingInitializer) {
  node2.declarations = [];
  node2.kind = kind;
  for (; ; ) {
    var decl = this.startNode();
    this.parseVarId(decl, kind);
    if (this.eat(types$1.eq)) {
      decl.init = this.parseMaybeAssign(isFor);
    } else if (!allowMissingInitializer && kind === "const" && !(this.type === types$1._in || this.options.ecmaVersion >= 6 && this.isContextual("of"))) {
      this.unexpected();
    } else if (!allowMissingInitializer && (kind === "using" || kind === "await using") && this.options.ecmaVersion >= 17 && this.type !== types$1._in && !this.isContextual("of")) {
      this.raise(this.lastTokEnd, "Missing initializer in " + kind + " declaration");
    } else if (!allowMissingInitializer && decl.id.type !== "Identifier" && !(isFor && (this.type === types$1._in || this.isContextual("of")))) {
      this.raise(this.lastTokEnd, "Complex binding patterns require an initialization value");
    } else {
      decl.init = null;
    }
    node2.declarations.push(this.finishNode(decl, "VariableDeclarator"));
    if (!this.eat(types$1.comma)) {
      break;
    }
  }
  return node2;
};
pp$8.parseVarId = function(decl, kind) {
  decl.id = kind === "using" || kind === "await using" ? this.parseIdent() : this.parseBindingAtom();
  this.checkLValPattern(decl.id, kind === "var" ? BIND_VAR : BIND_LEXICAL, false);
};
var FUNC_STATEMENT = 1;
var FUNC_HANGING_STATEMENT = 2;
var FUNC_NULLABLE_ID = 4;
pp$8.parseFunction = function(node2, statement2, allowExpressionBody, isAsync, forInit) {
  this.initFunction(node2);
  if (this.options.ecmaVersion >= 9 || this.options.ecmaVersion >= 6 && !isAsync) {
    if (this.type === types$1.star && statement2 & FUNC_HANGING_STATEMENT) {
      this.unexpected();
    }
    node2.generator = this.eat(types$1.star);
  }
  if (this.options.ecmaVersion >= 8) {
    node2.async = !!isAsync;
  }
  if (statement2 & FUNC_STATEMENT) {
    node2.id = statement2 & FUNC_NULLABLE_ID && this.type !== types$1.name ? null : this.parseIdent();
    if (node2.id && !(statement2 & FUNC_HANGING_STATEMENT)) {
      this.checkLValSimple(node2.id, this.strict || node2.generator || node2.async ? this.treatFunctionsAsVar ? BIND_VAR : BIND_LEXICAL : BIND_FUNCTION);
    }
  }
  var oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
  this.yieldPos = 0;
  this.awaitPos = 0;
  this.awaitIdentPos = 0;
  this.enterScope(functionFlags(node2.async, node2.generator));
  if (!(statement2 & FUNC_STATEMENT)) {
    node2.id = this.type === types$1.name ? this.parseIdent() : null;
  }
  this.parseFunctionParams(node2);
  this.parseFunctionBody(node2, allowExpressionBody, false, forInit);
  this.yieldPos = oldYieldPos;
  this.awaitPos = oldAwaitPos;
  this.awaitIdentPos = oldAwaitIdentPos;
  return this.finishNode(node2, statement2 & FUNC_STATEMENT ? "FunctionDeclaration" : "FunctionExpression");
};
pp$8.parseFunctionParams = function(node2) {
  this.expect(types$1.parenL);
  node2.params = this.parseBindingList(types$1.parenR, false, this.options.ecmaVersion >= 8);
  this.checkYieldAwaitInDefaultParams();
};
pp$8.parseClass = function(node2, isStatement) {
  this.next();
  var oldStrict = this.strict;
  this.strict = true;
  this.parseClassId(node2, isStatement);
  this.parseClassSuper(node2);
  var privateNameMap = this.enterClassBody();
  var classBody = this.startNode();
  var hadConstructor = false;
  classBody.body = [];
  this.expect(types$1.braceL);
  while (this.type !== types$1.braceR) {
    var element = this.parseClassElement(node2.superClass !== null);
    if (element) {
      classBody.body.push(element);
      if (element.type === "MethodDefinition" && element.kind === "constructor") {
        if (hadConstructor) {
          this.raiseRecoverable(element.start, "Duplicate constructor in the same class");
        }
        hadConstructor = true;
      } else if (element.key && element.key.type === "PrivateIdentifier" && isPrivateNameConflicted(privateNameMap, element)) {
        this.raiseRecoverable(element.key.start, "Identifier '#" + element.key.name + "' has already been declared");
      }
    }
  }
  this.strict = oldStrict;
  this.next();
  node2.body = this.finishNode(classBody, "ClassBody");
  this.exitClassBody();
  return this.finishNode(node2, isStatement ? "ClassDeclaration" : "ClassExpression");
};
pp$8.parseClassElement = function(constructorAllowsSuper) {
  if (this.eat(types$1.semi)) {
    return null;
  }
  var ecmaVersion = this.options.ecmaVersion;
  var node2 = this.startNode();
  var keyName = "";
  var isGenerator = false;
  var isAsync = false;
  var kind = "method";
  var isStatic = false;
  if (this.eatContextual("static")) {
    if (ecmaVersion >= 13 && this.eat(types$1.braceL)) {
      this.parseClassStaticBlock(node2);
      return node2;
    }
    if (this.isClassElementNameStart() || this.type === types$1.star) {
      isStatic = true;
    } else {
      keyName = "static";
    }
  }
  node2.static = isStatic;
  if (!keyName && ecmaVersion >= 8 && this.eatContextual("async")) {
    if ((this.isClassElementNameStart() || this.type === types$1.star) && !this.canInsertSemicolon()) {
      isAsync = true;
    } else {
      keyName = "async";
    }
  }
  if (!keyName && (ecmaVersion >= 9 || !isAsync) && this.eat(types$1.star)) {
    isGenerator = true;
  }
  if (!keyName && !isAsync && !isGenerator) {
    var lastValue = this.value;
    if (this.eatContextual("get") || this.eatContextual("set")) {
      if (this.isClassElementNameStart()) {
        kind = lastValue;
      } else {
        keyName = lastValue;
      }
    }
  }
  if (keyName) {
    node2.computed = false;
    node2.key = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc);
    node2.key.name = keyName;
    this.finishNode(node2.key, "Identifier");
  } else {
    this.parseClassElementName(node2);
  }
  if (ecmaVersion < 13 || this.type === types$1.parenL || kind !== "method" || isGenerator || isAsync) {
    var isConstructor = !node2.static && checkKeyName(node2, "constructor");
    var allowsDirectSuper = isConstructor && constructorAllowsSuper;
    if (isConstructor && kind !== "method") {
      this.raise(node2.key.start, "Constructor can't have get/set modifier");
    }
    node2.kind = isConstructor ? "constructor" : kind;
    this.parseClassMethod(node2, isGenerator, isAsync, allowsDirectSuper);
  } else {
    this.parseClassField(node2);
  }
  return node2;
};
pp$8.isClassElementNameStart = function() {
  return this.type === types$1.name || this.type === types$1.privateId || this.type === types$1.num || this.type === types$1.string || this.type === types$1.bracketL || this.type.keyword;
};
pp$8.parseClassElementName = function(element) {
  if (this.type === types$1.privateId) {
    if (this.value === "constructor") {
      this.raise(this.start, "Classes can't have an element named '#constructor'");
    }
    element.computed = false;
    element.key = this.parsePrivateIdent();
  } else {
    this.parsePropertyName(element);
  }
};
pp$8.parseClassMethod = function(method, isGenerator, isAsync, allowsDirectSuper) {
  var key = method.key;
  if (method.kind === "constructor") {
    if (isGenerator) {
      this.raise(key.start, "Constructor can't be a generator");
    }
    if (isAsync) {
      this.raise(key.start, "Constructor can't be an async method");
    }
  } else if (method.static && checkKeyName(method, "prototype")) {
    this.raise(key.start, "Classes may not have a static property named prototype");
  }
  var value = method.value = this.parseMethod(isGenerator, isAsync, allowsDirectSuper);
  if (method.kind === "get" && value.params.length !== 0) {
    this.raiseRecoverable(value.start, "getter should have no params");
  }
  if (method.kind === "set" && value.params.length !== 1) {
    this.raiseRecoverable(value.start, "setter should have exactly one param");
  }
  if (method.kind === "set" && value.params[0].type === "RestElement") {
    this.raiseRecoverable(value.params[0].start, "Setter cannot use rest params");
  }
  return this.finishNode(method, "MethodDefinition");
};
pp$8.parseClassField = function(field) {
  if (checkKeyName(field, "constructor")) {
    this.raise(field.key.start, "Classes can't have a field named 'constructor'");
  } else if (field.static && checkKeyName(field, "prototype")) {
    this.raise(field.key.start, "Classes can't have a static field named 'prototype'");
  }
  if (this.eat(types$1.eq)) {
    this.enterScope(SCOPE_CLASS_FIELD_INIT | SCOPE_SUPER);
    field.value = this.parseMaybeAssign();
    this.exitScope();
  } else {
    field.value = null;
  }
  this.semicolon();
  return this.finishNode(field, "PropertyDefinition");
};
pp$8.parseClassStaticBlock = function(node2) {
  node2.body = [];
  var oldLabels = this.labels;
  this.labels = [];
  this.enterScope(SCOPE_CLASS_STATIC_BLOCK | SCOPE_SUPER);
  while (this.type !== types$1.braceR) {
    var stmt2 = this.parseStatement(null);
    node2.body.push(stmt2);
  }
  this.next();
  this.exitScope();
  this.labels = oldLabels;
  return this.finishNode(node2, "StaticBlock");
};
pp$8.parseClassId = function(node2, isStatement) {
  if (this.type === types$1.name) {
    node2.id = this.parseIdent();
    if (isStatement) {
      this.checkLValSimple(node2.id, BIND_LEXICAL, false);
    }
  } else {
    if (isStatement === true) {
      this.unexpected();
    }
    node2.id = null;
  }
};
pp$8.parseClassSuper = function(node2) {
  node2.superClass = this.eat(types$1._extends) ? this.parseExprSubscripts(null, false) : null;
};
pp$8.enterClassBody = function() {
  var element = { declared: /* @__PURE__ */ Object.create(null), used: [] };
  this.privateNameStack.push(element);
  return element.declared;
};
pp$8.exitClassBody = function() {
  var ref2 = this.privateNameStack.pop();
  var declared = ref2.declared;
  var used = ref2.used;
  if (!this.options.checkPrivateFields) {
    return;
  }
  var len = this.privateNameStack.length;
  var parent = len === 0 ? null : this.privateNameStack[len - 1];
  for (var i = 0; i < used.length; ++i) {
    var id2 = used[i];
    if (!hasOwn(declared, id2.name)) {
      if (parent) {
        parent.used.push(id2);
      } else {
        this.raiseRecoverable(id2.start, "Private field '#" + id2.name + "' must be declared in an enclosing class");
      }
    }
  }
};
function isPrivateNameConflicted(privateNameMap, element) {
  var name2 = element.key.name;
  var curr = privateNameMap[name2];
  var next = "true";
  if (element.type === "MethodDefinition" && (element.kind === "get" || element.kind === "set")) {
    next = (element.static ? "s" : "i") + element.kind;
  }
  if (curr === "iget" && next === "iset" || curr === "iset" && next === "iget" || curr === "sget" && next === "sset" || curr === "sset" && next === "sget") {
    privateNameMap[name2] = "true";
    return false;
  } else if (!curr) {
    privateNameMap[name2] = next;
    return false;
  } else {
    return true;
  }
}
function checkKeyName(node2, name2) {
  var computed = node2.computed;
  var key = node2.key;
  return !computed && (key.type === "Identifier" && key.name === name2 || key.type === "Literal" && key.value === name2);
}
pp$8.parseExportAllDeclaration = function(node2, exports) {
  if (this.options.ecmaVersion >= 11) {
    if (this.eatContextual("as")) {
      node2.exported = this.parseModuleExportName();
      this.checkExport(exports, node2.exported, this.lastTokStart);
    } else {
      node2.exported = null;
    }
  }
  this.expectContextual("from");
  if (this.type !== types$1.string) {
    this.unexpected();
  }
  node2.source = this.parseExprAtom();
  if (this.options.ecmaVersion >= 16) {
    node2.attributes = this.parseWithClause();
  }
  this.semicolon();
  return this.finishNode(node2, "ExportAllDeclaration");
};
pp$8.parseExport = function(node2, exports) {
  this.next();
  if (this.eat(types$1.star)) {
    return this.parseExportAllDeclaration(node2, exports);
  }
  if (this.eat(types$1._default)) {
    this.checkExport(exports, "default", this.lastTokStart);
    node2.declaration = this.parseExportDefaultDeclaration();
    return this.finishNode(node2, "ExportDefaultDeclaration");
  }
  if (this.shouldParseExportStatement()) {
    node2.declaration = this.parseExportDeclaration(node2);
    if (node2.declaration.type === "VariableDeclaration") {
      this.checkVariableExport(exports, node2.declaration.declarations);
    } else {
      this.checkExport(exports, node2.declaration.id, node2.declaration.id.start);
    }
    node2.specifiers = [];
    node2.source = null;
    if (this.options.ecmaVersion >= 16) {
      node2.attributes = [];
    }
  } else {
    node2.declaration = null;
    node2.specifiers = this.parseExportSpecifiers(exports);
    if (this.eatContextual("from")) {
      if (this.type !== types$1.string) {
        this.unexpected();
      }
      node2.source = this.parseExprAtom();
      if (this.options.ecmaVersion >= 16) {
        node2.attributes = this.parseWithClause();
      }
    } else {
      for (var i = 0, list = node2.specifiers; i < list.length; i += 1) {
        var spec2 = list[i];
        this.checkUnreserved(spec2.local);
        this.checkLocalExport(spec2.local);
        if (spec2.local.type === "Literal") {
          this.raise(spec2.local.start, "A string literal cannot be used as an exported binding without `from`.");
        }
      }
      node2.source = null;
      if (this.options.ecmaVersion >= 16) {
        node2.attributes = [];
      }
    }
    this.semicolon();
  }
  return this.finishNode(node2, "ExportNamedDeclaration");
};
pp$8.parseExportDeclaration = function(node2) {
  return this.parseStatement(null);
};
pp$8.parseExportDefaultDeclaration = function() {
  var isAsync;
  if (this.type === types$1._function || (isAsync = this.isAsyncFunction())) {
    var fNode = this.startNode();
    this.next();
    if (isAsync) {
      this.next();
    }
    return this.parseFunction(fNode, FUNC_STATEMENT | FUNC_NULLABLE_ID, false, isAsync);
  } else if (this.type === types$1._class) {
    var cNode = this.startNode();
    return this.parseClass(cNode, "nullableID");
  } else {
    var declaration = this.parseMaybeAssign();
    this.semicolon();
    return declaration;
  }
};
pp$8.checkExport = function(exports, name2, pos) {
  if (!exports) {
    return;
  }
  if (typeof name2 !== "string") {
    name2 = name2.type === "Identifier" ? name2.name : name2.value;
  }
  if (hasOwn(exports, name2)) {
    this.raiseRecoverable(pos, "Duplicate export '" + name2 + "'");
  }
  exports[name2] = true;
};
pp$8.checkPatternExport = function(exports, pat) {
  var type = pat.type;
  if (type === "Identifier") {
    this.checkExport(exports, pat, pat.start);
  } else if (type === "ObjectPattern") {
    for (var i = 0, list = pat.properties; i < list.length; i += 1) {
      var prop = list[i];
      this.checkPatternExport(exports, prop);
    }
  } else if (type === "ArrayPattern") {
    for (var i$1 = 0, list$1 = pat.elements; i$1 < list$1.length; i$1 += 1) {
      var elt = list$1[i$1];
      if (elt) {
        this.checkPatternExport(exports, elt);
      }
    }
  } else if (type === "Property") {
    this.checkPatternExport(exports, pat.value);
  } else if (type === "AssignmentPattern") {
    this.checkPatternExport(exports, pat.left);
  } else if (type === "RestElement") {
    this.checkPatternExport(exports, pat.argument);
  }
};
pp$8.checkVariableExport = function(exports, decls) {
  if (!exports) {
    return;
  }
  for (var i = 0, list = decls; i < list.length; i += 1) {
    var decl = list[i];
    this.checkPatternExport(exports, decl.id);
  }
};
pp$8.shouldParseExportStatement = function() {
  return this.type.keyword === "var" || this.type.keyword === "const" || this.type.keyword === "class" || this.type.keyword === "function" || this.isLet() || this.isAsyncFunction();
};
pp$8.parseExportSpecifier = function(exports) {
  var node2 = this.startNode();
  node2.local = this.parseModuleExportName();
  node2.exported = this.eatContextual("as") ? this.parseModuleExportName() : node2.local;
  this.checkExport(
    exports,
    node2.exported,
    node2.exported.start
  );
  return this.finishNode(node2, "ExportSpecifier");
};
pp$8.parseExportSpecifiers = function(exports) {
  var nodes = [], first = true;
  this.expect(types$1.braceL);
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.afterTrailingComma(types$1.braceR)) {
        break;
      }
    } else {
      first = false;
    }
    nodes.push(this.parseExportSpecifier(exports));
  }
  return nodes;
};
pp$8.parseImport = function(node2) {
  this.next();
  if (this.type === types$1.string) {
    node2.specifiers = empty$1;
    node2.source = this.parseExprAtom();
  } else {
    node2.specifiers = this.parseImportSpecifiers();
    this.expectContextual("from");
    node2.source = this.type === types$1.string ? this.parseExprAtom() : this.unexpected();
  }
  if (this.options.ecmaVersion >= 16) {
    node2.attributes = this.parseWithClause();
  }
  this.semicolon();
  return this.finishNode(node2, "ImportDeclaration");
};
pp$8.parseImportSpecifier = function() {
  var node2 = this.startNode();
  node2.imported = this.parseModuleExportName();
  if (this.eatContextual("as")) {
    node2.local = this.parseIdent();
  } else {
    this.checkUnreserved(node2.imported);
    node2.local = node2.imported;
  }
  this.checkLValSimple(node2.local, BIND_LEXICAL);
  return this.finishNode(node2, "ImportSpecifier");
};
pp$8.parseImportDefaultSpecifier = function() {
  var node2 = this.startNode();
  node2.local = this.parseIdent();
  this.checkLValSimple(node2.local, BIND_LEXICAL);
  return this.finishNode(node2, "ImportDefaultSpecifier");
};
pp$8.parseImportNamespaceSpecifier = function() {
  var node2 = this.startNode();
  this.next();
  this.expectContextual("as");
  node2.local = this.parseIdent();
  this.checkLValSimple(node2.local, BIND_LEXICAL);
  return this.finishNode(node2, "ImportNamespaceSpecifier");
};
pp$8.parseImportSpecifiers = function() {
  var nodes = [], first = true;
  if (this.type === types$1.name) {
    nodes.push(this.parseImportDefaultSpecifier());
    if (!this.eat(types$1.comma)) {
      return nodes;
    }
  }
  if (this.type === types$1.star) {
    nodes.push(this.parseImportNamespaceSpecifier());
    return nodes;
  }
  this.expect(types$1.braceL);
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.afterTrailingComma(types$1.braceR)) {
        break;
      }
    } else {
      first = false;
    }
    nodes.push(this.parseImportSpecifier());
  }
  return nodes;
};
pp$8.parseWithClause = function() {
  var nodes = [];
  if (!this.eat(types$1._with)) {
    return nodes;
  }
  this.expect(types$1.braceL);
  var attributeKeys = {};
  var first = true;
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.afterTrailingComma(types$1.braceR)) {
        break;
      }
    } else {
      first = false;
    }
    var attr = this.parseImportAttribute();
    var keyName = attr.key.type === "Identifier" ? attr.key.name : attr.key.value;
    if (hasOwn(attributeKeys, keyName)) {
      this.raiseRecoverable(attr.key.start, "Duplicate attribute key '" + keyName + "'");
    }
    attributeKeys[keyName] = true;
    nodes.push(attr);
  }
  return nodes;
};
pp$8.parseImportAttribute = function() {
  var node2 = this.startNode();
  node2.key = this.type === types$1.string ? this.parseExprAtom() : this.parseIdent(this.options.allowReserved !== "never");
  this.expect(types$1.colon);
  if (this.type !== types$1.string) {
    this.unexpected();
  }
  node2.value = this.parseExprAtom();
  return this.finishNode(node2, "ImportAttribute");
};
pp$8.parseModuleExportName = function() {
  if (this.options.ecmaVersion >= 13 && this.type === types$1.string) {
    var stringLiteral = this.parseLiteral(this.value);
    if (loneSurrogate.test(stringLiteral.value)) {
      this.raise(stringLiteral.start, "An export name cannot include a lone surrogate.");
    }
    return stringLiteral;
  }
  return this.parseIdent(true);
};
pp$8.adaptDirectivePrologue = function(statements) {
  for (var i = 0; i < statements.length && this.isDirectiveCandidate(statements[i]); ++i) {
    statements[i].directive = statements[i].expression.raw.slice(1, -1);
  }
};
pp$8.isDirectiveCandidate = function(statement2) {
  return this.options.ecmaVersion >= 5 && statement2.type === "ExpressionStatement" && statement2.expression.type === "Literal" && typeof statement2.expression.value === "string" && // Reject parenthesized strings.
  (this.input[statement2.start] === '"' || this.input[statement2.start] === "'");
};
var pp$7 = Parser.prototype;
pp$7.toAssignable = function(node2, isBinding, refDestructuringErrors) {
  if (this.options.ecmaVersion >= 6 && node2) {
    switch (node2.type) {
      case "Identifier":
        if (this.inAsync && node2.name === "await") {
          this.raise(node2.start, "Cannot use 'await' as identifier inside an async function");
        }
        break;
      case "ObjectPattern":
      case "ArrayPattern":
      case "AssignmentPattern":
      case "RestElement":
        break;
      case "ObjectExpression":
        node2.type = "ObjectPattern";
        if (refDestructuringErrors) {
          this.checkPatternErrors(refDestructuringErrors, true);
        }
        for (var i = 0, list = node2.properties; i < list.length; i += 1) {
          var prop = list[i];
          this.toAssignable(prop, isBinding);
          if (prop.type === "RestElement" && (prop.argument.type === "ArrayPattern" || prop.argument.type === "ObjectPattern")) {
            this.raise(prop.argument.start, "Unexpected token");
          }
        }
        break;
      case "Property":
        if (node2.kind !== "init") {
          this.raise(node2.key.start, "Object pattern can't contain getter or setter");
        }
        this.toAssignable(node2.value, isBinding);
        break;
      case "ArrayExpression":
        node2.type = "ArrayPattern";
        if (refDestructuringErrors) {
          this.checkPatternErrors(refDestructuringErrors, true);
        }
        this.toAssignableList(node2.elements, isBinding);
        break;
      case "SpreadElement":
        node2.type = "RestElement";
        this.toAssignable(node2.argument, isBinding);
        if (node2.argument.type === "AssignmentPattern") {
          this.raise(node2.argument.start, "Rest elements cannot have a default value");
        }
        break;
      case "AssignmentExpression":
        if (node2.operator !== "=") {
          this.raise(node2.left.end, "Only '=' operator can be used for specifying default value.");
        }
        node2.type = "AssignmentPattern";
        delete node2.operator;
        this.toAssignable(node2.left, isBinding);
        break;
      case "ParenthesizedExpression":
        this.toAssignable(node2.expression, isBinding, refDestructuringErrors);
        break;
      case "ChainExpression":
        this.raiseRecoverable(node2.start, "Optional chaining cannot appear in left-hand side");
        break;
      case "MemberExpression":
        if (!isBinding) {
          break;
        }
      default:
        this.raise(node2.start, "Assigning to rvalue");
    }
  } else if (refDestructuringErrors) {
    this.checkPatternErrors(refDestructuringErrors, true);
  }
  return node2;
};
pp$7.toAssignableList = function(exprList, isBinding) {
  var end = exprList.length;
  for (var i = 0; i < end; i++) {
    var elt = exprList[i];
    if (elt) {
      this.toAssignable(elt, isBinding);
    }
  }
  if (end) {
    var last = exprList[end - 1];
    if (this.options.ecmaVersion === 6 && isBinding && last && last.type === "RestElement" && last.argument.type !== "Identifier") {
      this.unexpected(last.argument.start);
    }
  }
  return exprList;
};
pp$7.parseSpread = function(refDestructuringErrors) {
  var node2 = this.startNode();
  this.next();
  node2.argument = this.parseMaybeAssign(false, refDestructuringErrors);
  return this.finishNode(node2, "SpreadElement");
};
pp$7.parseRestBinding = function() {
  var node2 = this.startNode();
  this.next();
  if (this.options.ecmaVersion === 6 && this.type !== types$1.name) {
    this.unexpected();
  }
  node2.argument = this.parseBindingAtom();
  return this.finishNode(node2, "RestElement");
};
pp$7.parseBindingAtom = function() {
  if (this.options.ecmaVersion >= 6) {
    switch (this.type) {
      case types$1.bracketL:
        var node2 = this.startNode();
        this.next();
        node2.elements = this.parseBindingList(types$1.bracketR, true, true);
        return this.finishNode(node2, "ArrayPattern");
      case types$1.braceL:
        return this.parseObj(true);
    }
  }
  return this.parseIdent();
};
pp$7.parseBindingList = function(close, allowEmpty, allowTrailingComma, allowModifiers) {
  var elts = [], first = true;
  while (!this.eat(close)) {
    if (first) {
      first = false;
    } else {
      this.expect(types$1.comma);
    }
    if (allowEmpty && this.type === types$1.comma) {
      elts.push(null);
    } else if (allowTrailingComma && this.afterTrailingComma(close)) {
      break;
    } else if (this.type === types$1.ellipsis) {
      var rest = this.parseRestBinding();
      this.parseBindingListItem(rest);
      elts.push(rest);
      if (this.type === types$1.comma) {
        this.raiseRecoverable(this.start, "Comma is not permitted after the rest element");
      }
      this.expect(close);
      break;
    } else {
      elts.push(this.parseAssignableListItem(allowModifiers));
    }
  }
  return elts;
};
pp$7.parseAssignableListItem = function(allowModifiers) {
  var elem = this.parseMaybeDefault(this.start, this.startLoc);
  this.parseBindingListItem(elem);
  return elem;
};
pp$7.parseBindingListItem = function(param) {
  return param;
};
pp$7.parseMaybeDefault = function(startPos, startLoc, left) {
  left = left || this.parseBindingAtom();
  if (this.options.ecmaVersion < 6 || !this.eat(types$1.eq)) {
    return left;
  }
  var node2 = this.startNodeAt(startPos, startLoc);
  node2.left = left;
  node2.right = this.parseMaybeAssign();
  return this.finishNode(node2, "AssignmentPattern");
};
pp$7.checkLValSimple = function(expr2, bindingType, checkClashes) {
  if (bindingType === void 0) bindingType = BIND_NONE;
  var isBind = bindingType !== BIND_NONE;
  switch (expr2.type) {
    case "Identifier":
      if (this.strict && this.reservedWordsStrictBind.test(expr2.name)) {
        this.raiseRecoverable(expr2.start, (isBind ? "Binding " : "Assigning to ") + expr2.name + " in strict mode");
      }
      if (isBind) {
        if (bindingType === BIND_LEXICAL && expr2.name === "let") {
          this.raiseRecoverable(expr2.start, "let is disallowed as a lexically bound name");
        }
        if (checkClashes) {
          if (hasOwn(checkClashes, expr2.name)) {
            this.raiseRecoverable(expr2.start, "Argument name clash");
          }
          checkClashes[expr2.name] = true;
        }
        if (bindingType !== BIND_OUTSIDE) {
          this.declareName(expr2.name, bindingType, expr2.start);
        }
      }
      break;
    case "ChainExpression":
      this.raiseRecoverable(expr2.start, "Optional chaining cannot appear in left-hand side");
      break;
    case "MemberExpression":
      if (isBind) {
        this.raiseRecoverable(expr2.start, "Binding member expression");
      }
      break;
    case "ParenthesizedExpression":
      if (isBind) {
        this.raiseRecoverable(expr2.start, "Binding parenthesized expression");
      }
      return this.checkLValSimple(expr2.expression, bindingType, checkClashes);
    default:
      this.raise(expr2.start, (isBind ? "Binding" : "Assigning to") + " rvalue");
  }
};
pp$7.checkLValPattern = function(expr2, bindingType, checkClashes) {
  if (bindingType === void 0) bindingType = BIND_NONE;
  switch (expr2.type) {
    case "ObjectPattern":
      for (var i = 0, list = expr2.properties; i < list.length; i += 1) {
        var prop = list[i];
        this.checkLValInnerPattern(prop, bindingType, checkClashes);
      }
      break;
    case "ArrayPattern":
      for (var i$1 = 0, list$1 = expr2.elements; i$1 < list$1.length; i$1 += 1) {
        var elem = list$1[i$1];
        if (elem) {
          this.checkLValInnerPattern(elem, bindingType, checkClashes);
        }
      }
      break;
    default:
      this.checkLValSimple(expr2, bindingType, checkClashes);
  }
};
pp$7.checkLValInnerPattern = function(expr2, bindingType, checkClashes) {
  if (bindingType === void 0) bindingType = BIND_NONE;
  switch (expr2.type) {
    case "Property":
      this.checkLValInnerPattern(expr2.value, bindingType, checkClashes);
      break;
    case "AssignmentPattern":
      this.checkLValPattern(expr2.left, bindingType, checkClashes);
      break;
    case "RestElement":
      this.checkLValPattern(expr2.argument, bindingType, checkClashes);
      break;
    default:
      this.checkLValPattern(expr2, bindingType, checkClashes);
  }
};
var TokContext = function TokContext2(token, isExpr, preserveSpace, override, generator) {
  this.token = token;
  this.isExpr = !!isExpr;
  this.preserveSpace = !!preserveSpace;
  this.override = override;
  this.generator = !!generator;
};
var types = {
  b_stat: new TokContext("{", false),
  b_expr: new TokContext("{", true),
  b_tmpl: new TokContext("${", false),
  p_stat: new TokContext("(", false),
  p_expr: new TokContext("(", true),
  q_tmpl: new TokContext("`", true, true, function(p) {
    return p.tryReadTemplateToken();
  }),
  f_stat: new TokContext("function", false),
  f_expr: new TokContext("function", true),
  f_expr_gen: new TokContext("function", true, false, null, true),
  f_gen: new TokContext("function", false, false, null, true)
};
var pp$6 = Parser.prototype;
pp$6.initialContext = function() {
  return [types.b_stat];
};
pp$6.curContext = function() {
  return this.context[this.context.length - 1];
};
pp$6.braceIsBlock = function(prevType) {
  var parent = this.curContext();
  if (parent === types.f_expr || parent === types.f_stat) {
    return true;
  }
  if (prevType === types$1.colon && (parent === types.b_stat || parent === types.b_expr)) {
    return !parent.isExpr;
  }
  if (prevType === types$1._return || prevType === types$1.name && this.exprAllowed) {
    return lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
  }
  if (prevType === types$1._else || prevType === types$1.semi || prevType === types$1.eof || prevType === types$1.parenR || prevType === types$1.arrow) {
    return true;
  }
  if (prevType === types$1.braceL) {
    return parent === types.b_stat;
  }
  if (prevType === types$1._var || prevType === types$1._const || prevType === types$1.name) {
    return false;
  }
  return !this.exprAllowed;
};
pp$6.inGeneratorContext = function() {
  for (var i = this.context.length - 1; i >= 1; i--) {
    var context = this.context[i];
    if (context.token === "function") {
      return context.generator;
    }
  }
  return false;
};
pp$6.updateContext = function(prevType) {
  var update, type = this.type;
  if (type.keyword && prevType === types$1.dot) {
    this.exprAllowed = false;
  } else if (update = type.updateContext) {
    update.call(this, prevType);
  } else {
    this.exprAllowed = type.beforeExpr;
  }
};
pp$6.overrideContext = function(tokenCtx) {
  if (this.curContext() !== tokenCtx) {
    this.context[this.context.length - 1] = tokenCtx;
  }
};
types$1.parenR.updateContext = types$1.braceR.updateContext = function() {
  if (this.context.length === 1) {
    this.exprAllowed = true;
    return;
  }
  var out = this.context.pop();
  if (out === types.b_stat && this.curContext().token === "function") {
    out = this.context.pop();
  }
  this.exprAllowed = !out.isExpr;
};
types$1.braceL.updateContext = function(prevType) {
  this.context.push(this.braceIsBlock(prevType) ? types.b_stat : types.b_expr);
  this.exprAllowed = true;
};
types$1.dollarBraceL.updateContext = function() {
  this.context.push(types.b_tmpl);
  this.exprAllowed = true;
};
types$1.parenL.updateContext = function(prevType) {
  var statementParens = prevType === types$1._if || prevType === types$1._for || prevType === types$1._with || prevType === types$1._while;
  this.context.push(statementParens ? types.p_stat : types.p_expr);
  this.exprAllowed = true;
};
types$1.incDec.updateContext = function() {
};
types$1._function.updateContext = types$1._class.updateContext = function(prevType) {
  if (prevType.beforeExpr && prevType !== types$1._else && !(prevType === types$1.semi && this.curContext() !== types.p_stat) && !(prevType === types$1._return && lineBreak.test(this.input.slice(this.lastTokEnd, this.start))) && !((prevType === types$1.colon || prevType === types$1.braceL) && this.curContext() === types.b_stat)) {
    this.context.push(types.f_expr);
  } else {
    this.context.push(types.f_stat);
  }
  this.exprAllowed = false;
};
types$1.colon.updateContext = function() {
  if (this.curContext().token === "function") {
    this.context.pop();
  }
  this.exprAllowed = true;
};
types$1.backQuote.updateContext = function() {
  if (this.curContext() === types.q_tmpl) {
    this.context.pop();
  } else {
    this.context.push(types.q_tmpl);
  }
  this.exprAllowed = false;
};
types$1.star.updateContext = function(prevType) {
  if (prevType === types$1._function) {
    var index = this.context.length - 1;
    if (this.context[index] === types.f_expr) {
      this.context[index] = types.f_expr_gen;
    } else {
      this.context[index] = types.f_gen;
    }
  }
  this.exprAllowed = true;
};
types$1.name.updateContext = function(prevType) {
  var allowed = false;
  if (this.options.ecmaVersion >= 6 && prevType !== types$1.dot) {
    if (this.value === "of" && !this.exprAllowed || this.value === "yield" && this.inGeneratorContext()) {
      allowed = true;
    }
  }
  this.exprAllowed = allowed;
};
var pp$5 = Parser.prototype;
pp$5.checkPropClash = function(prop, propHash, refDestructuringErrors) {
  if (this.options.ecmaVersion >= 9 && prop.type === "SpreadElement") {
    return;
  }
  if (this.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand)) {
    return;
  }
  var key = prop.key;
  var name2;
  switch (key.type) {
    case "Identifier":
      name2 = key.name;
      break;
    case "Literal":
      name2 = String(key.value);
      break;
    default:
      return;
  }
  var kind = prop.kind;
  if (this.options.ecmaVersion >= 6) {
    if (name2 === "__proto__" && kind === "init") {
      if (propHash.proto) {
        if (refDestructuringErrors) {
          if (refDestructuringErrors.doubleProto < 0) {
            refDestructuringErrors.doubleProto = key.start;
          }
        } else {
          this.raiseRecoverable(key.start, "Redefinition of __proto__ property");
        }
      }
      propHash.proto = true;
    }
    return;
  }
  name2 = "$" + name2;
  var other = propHash[name2];
  if (other) {
    var redefinition;
    if (kind === "init") {
      redefinition = this.strict && other.init || other.get || other.set;
    } else {
      redefinition = other.init || other[kind];
    }
    if (redefinition) {
      this.raiseRecoverable(key.start, "Redefinition of property");
    }
  } else {
    other = propHash[name2] = {
      init: false,
      get: false,
      set: false
    };
  }
  other[kind] = true;
};
pp$5.parseExpression = function(forInit, refDestructuringErrors) {
  var startPos = this.start, startLoc = this.startLoc;
  var expr2 = this.parseMaybeAssign(forInit, refDestructuringErrors);
  if (this.type === types$1.comma) {
    var node2 = this.startNodeAt(startPos, startLoc);
    node2.expressions = [expr2];
    while (this.eat(types$1.comma)) {
      node2.expressions.push(this.parseMaybeAssign(forInit, refDestructuringErrors));
    }
    return this.finishNode(node2, "SequenceExpression");
  }
  return expr2;
};
pp$5.parseMaybeAssign = function(forInit, refDestructuringErrors, afterLeftParse) {
  if (this.isContextual("yield")) {
    if (this.inGenerator) {
      return this.parseYield(forInit);
    } else {
      this.exprAllowed = false;
    }
  }
  var ownDestructuringErrors = false, oldParenAssign = -1, oldTrailingComma = -1, oldDoubleProto = -1;
  if (refDestructuringErrors) {
    oldParenAssign = refDestructuringErrors.parenthesizedAssign;
    oldTrailingComma = refDestructuringErrors.trailingComma;
    oldDoubleProto = refDestructuringErrors.doubleProto;
    refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = -1;
  } else {
    refDestructuringErrors = new DestructuringErrors();
    ownDestructuringErrors = true;
  }
  var startPos = this.start, startLoc = this.startLoc;
  if (this.type === types$1.parenL || this.type === types$1.name) {
    this.potentialArrowAt = this.start;
    this.potentialArrowInForAwait = forInit === "await";
  }
  var left = this.parseMaybeConditional(forInit, refDestructuringErrors);
  if (afterLeftParse) {
    left = afterLeftParse.call(this, left, startPos, startLoc);
  }
  if (this.type.isAssign) {
    var node2 = this.startNodeAt(startPos, startLoc);
    node2.operator = this.value;
    if (this.type === types$1.eq) {
      left = this.toAssignable(left, false, refDestructuringErrors);
    }
    if (!ownDestructuringErrors) {
      refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = refDestructuringErrors.doubleProto = -1;
    }
    if (refDestructuringErrors.shorthandAssign >= left.start) {
      refDestructuringErrors.shorthandAssign = -1;
    }
    if (this.type === types$1.eq) {
      this.checkLValPattern(left);
    } else {
      this.checkLValSimple(left);
    }
    node2.left = left;
    this.next();
    node2.right = this.parseMaybeAssign(forInit);
    if (oldDoubleProto > -1) {
      refDestructuringErrors.doubleProto = oldDoubleProto;
    }
    return this.finishNode(node2, "AssignmentExpression");
  } else {
    if (ownDestructuringErrors) {
      this.checkExpressionErrors(refDestructuringErrors, true);
    }
  }
  if (oldParenAssign > -1) {
    refDestructuringErrors.parenthesizedAssign = oldParenAssign;
  }
  if (oldTrailingComma > -1) {
    refDestructuringErrors.trailingComma = oldTrailingComma;
  }
  return left;
};
pp$5.parseMaybeConditional = function(forInit, refDestructuringErrors) {
  var startPos = this.start, startLoc = this.startLoc;
  var expr2 = this.parseExprOps(forInit, refDestructuringErrors);
  if (this.checkExpressionErrors(refDestructuringErrors)) {
    return expr2;
  }
  if (this.eat(types$1.question)) {
    var node2 = this.startNodeAt(startPos, startLoc);
    node2.test = expr2;
    node2.consequent = this.parseMaybeAssign();
    this.expect(types$1.colon);
    node2.alternate = this.parseMaybeAssign(forInit);
    return this.finishNode(node2, "ConditionalExpression");
  }
  return expr2;
};
pp$5.parseExprOps = function(forInit, refDestructuringErrors) {
  var startPos = this.start, startLoc = this.startLoc;
  var expr2 = this.parseMaybeUnary(refDestructuringErrors, false, false, forInit);
  if (this.checkExpressionErrors(refDestructuringErrors)) {
    return expr2;
  }
  return expr2.start === startPos && expr2.type === "ArrowFunctionExpression" ? expr2 : this.parseExprOp(expr2, startPos, startLoc, -1, forInit);
};
pp$5.parseExprOp = function(left, leftStartPos, leftStartLoc, minPrec, forInit) {
  var prec = this.type.binop;
  if (prec != null && (!forInit || this.type !== types$1._in)) {
    if (prec > minPrec) {
      var logical = this.type === types$1.logicalOR || this.type === types$1.logicalAND;
      var coalesce = this.type === types$1.coalesce;
      if (coalesce) {
        prec = types$1.logicalAND.binop;
      }
      var op = this.value;
      this.next();
      var startPos = this.start, startLoc = this.startLoc;
      var right = this.parseExprOp(this.parseMaybeUnary(null, false, false, forInit), startPos, startLoc, prec, forInit);
      var node2 = this.buildBinary(leftStartPos, leftStartLoc, left, right, op, logical || coalesce);
      if (logical && this.type === types$1.coalesce || coalesce && (this.type === types$1.logicalOR || this.type === types$1.logicalAND)) {
        this.raiseRecoverable(this.start, "Logical expressions and coalesce expressions cannot be mixed. Wrap either by parentheses");
      }
      return this.parseExprOp(node2, leftStartPos, leftStartLoc, minPrec, forInit);
    }
  }
  return left;
};
pp$5.buildBinary = function(startPos, startLoc, left, right, op, logical) {
  if (right.type === "PrivateIdentifier") {
    this.raise(right.start, "Private identifier can only be left side of binary expression");
  }
  var node2 = this.startNodeAt(startPos, startLoc);
  node2.left = left;
  node2.operator = op;
  node2.right = right;
  return this.finishNode(node2, logical ? "LogicalExpression" : "BinaryExpression");
};
pp$5.parseMaybeUnary = function(refDestructuringErrors, sawUnary, incDec, forInit) {
  var startPos = this.start, startLoc = this.startLoc, expr2;
  if (this.isContextual("await") && this.canAwait) {
    expr2 = this.parseAwait(forInit);
    sawUnary = true;
  } else if (this.type.prefix) {
    var node2 = this.startNode(), update = this.type === types$1.incDec;
    node2.operator = this.value;
    node2.prefix = true;
    this.next();
    node2.argument = this.parseMaybeUnary(null, true, update, forInit);
    this.checkExpressionErrors(refDestructuringErrors, true);
    if (update) {
      this.checkLValSimple(node2.argument);
    } else if (this.strict && node2.operator === "delete" && isLocalVariableAccess(node2.argument)) {
      this.raiseRecoverable(node2.start, "Deleting local variable in strict mode");
    } else if (node2.operator === "delete" && isPrivateFieldAccess(node2.argument)) {
      this.raiseRecoverable(node2.start, "Private fields can not be deleted");
    } else {
      sawUnary = true;
    }
    expr2 = this.finishNode(node2, update ? "UpdateExpression" : "UnaryExpression");
  } else if (!sawUnary && this.type === types$1.privateId) {
    if ((forInit || this.privateNameStack.length === 0) && this.options.checkPrivateFields) {
      this.unexpected();
    }
    expr2 = this.parsePrivateIdent();
    if (this.type !== types$1._in) {
      this.unexpected();
    }
  } else {
    expr2 = this.parseExprSubscripts(refDestructuringErrors, forInit);
    if (this.checkExpressionErrors(refDestructuringErrors)) {
      return expr2;
    }
    while (this.type.postfix && !this.canInsertSemicolon()) {
      var node$1 = this.startNodeAt(startPos, startLoc);
      node$1.operator = this.value;
      node$1.prefix = false;
      node$1.argument = expr2;
      this.checkLValSimple(expr2);
      this.next();
      expr2 = this.finishNode(node$1, "UpdateExpression");
    }
  }
  if (!incDec && this.eat(types$1.starstar)) {
    if (sawUnary) {
      this.unexpected(this.lastTokStart);
    } else {
      return this.buildBinary(startPos, startLoc, expr2, this.parseMaybeUnary(null, false, false, forInit), "**", false);
    }
  } else {
    return expr2;
  }
};
function isLocalVariableAccess(node2) {
  return node2.type === "Identifier" || node2.type === "ParenthesizedExpression" && isLocalVariableAccess(node2.expression);
}
function isPrivateFieldAccess(node2) {
  return node2.type === "MemberExpression" && node2.property.type === "PrivateIdentifier" || node2.type === "ChainExpression" && isPrivateFieldAccess(node2.expression) || node2.type === "ParenthesizedExpression" && isPrivateFieldAccess(node2.expression);
}
pp$5.parseExprSubscripts = function(refDestructuringErrors, forInit) {
  var startPos = this.start, startLoc = this.startLoc;
  var expr2 = this.parseExprAtom(refDestructuringErrors, forInit);
  if (expr2.type === "ArrowFunctionExpression" && this.input.slice(this.lastTokStart, this.lastTokEnd) !== ")") {
    return expr2;
  }
  var result = this.parseSubscripts(expr2, startPos, startLoc, false, forInit);
  if (refDestructuringErrors && result.type === "MemberExpression") {
    if (refDestructuringErrors.parenthesizedAssign >= result.start) {
      refDestructuringErrors.parenthesizedAssign = -1;
    }
    if (refDestructuringErrors.parenthesizedBind >= result.start) {
      refDestructuringErrors.parenthesizedBind = -1;
    }
    if (refDestructuringErrors.trailingComma >= result.start) {
      refDestructuringErrors.trailingComma = -1;
    }
  }
  return result;
};
pp$5.parseSubscripts = function(base, startPos, startLoc, noCalls, forInit) {
  var maybeAsyncArrow = this.options.ecmaVersion >= 8 && base.type === "Identifier" && base.name === "async" && this.lastTokEnd === base.end && !this.canInsertSemicolon() && base.end - base.start === 5 && this.potentialArrowAt === base.start;
  var optionalChained = false;
  while (true) {
    var element = this.parseSubscript(base, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit);
    if (element.optional) {
      optionalChained = true;
    }
    if (element === base || element.type === "ArrowFunctionExpression") {
      if (optionalChained) {
        var chainNode = this.startNodeAt(startPos, startLoc);
        chainNode.expression = element;
        element = this.finishNode(chainNode, "ChainExpression");
      }
      return element;
    }
    base = element;
  }
};
pp$5.shouldParseAsyncArrow = function() {
  return !this.canInsertSemicolon() && this.eat(types$1.arrow);
};
pp$5.parseSubscriptAsyncArrow = function(startPos, startLoc, exprList, forInit) {
  return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, true, forInit);
};
pp$5.parseSubscript = function(base, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit) {
  var optionalSupported = this.options.ecmaVersion >= 11;
  var optional2 = optionalSupported && this.eat(types$1.questionDot);
  if (noCalls && optional2) {
    this.raise(this.lastTokStart, "Optional chaining cannot appear in the callee of new expressions");
  }
  var computed = this.eat(types$1.bracketL);
  if (computed || optional2 && this.type !== types$1.parenL && this.type !== types$1.backQuote || this.eat(types$1.dot)) {
    var node2 = this.startNodeAt(startPos, startLoc);
    node2.object = base;
    if (computed) {
      node2.property = this.parseExpression();
      this.expect(types$1.bracketR);
    } else if (this.type === types$1.privateId && base.type !== "Super") {
      node2.property = this.parsePrivateIdent();
    } else {
      node2.property = this.parseIdent(this.options.allowReserved !== "never");
    }
    node2.computed = !!computed;
    if (optionalSupported) {
      node2.optional = optional2;
    }
    base = this.finishNode(node2, "MemberExpression");
  } else if (!noCalls && this.eat(types$1.parenL)) {
    var refDestructuringErrors = new DestructuringErrors(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
    this.yieldPos = 0;
    this.awaitPos = 0;
    this.awaitIdentPos = 0;
    var exprList = this.parseExprList(types$1.parenR, this.options.ecmaVersion >= 8, false, refDestructuringErrors);
    if (maybeAsyncArrow && !optional2 && this.shouldParseAsyncArrow()) {
      this.checkPatternErrors(refDestructuringErrors, false);
      this.checkYieldAwaitInDefaultParams();
      if (this.awaitIdentPos > 0) {
        this.raise(this.awaitIdentPos, "Cannot use 'await' as identifier inside an async function");
      }
      this.yieldPos = oldYieldPos;
      this.awaitPos = oldAwaitPos;
      this.awaitIdentPos = oldAwaitIdentPos;
      return this.parseSubscriptAsyncArrow(startPos, startLoc, exprList, forInit);
    }
    this.checkExpressionErrors(refDestructuringErrors, true);
    this.yieldPos = oldYieldPos || this.yieldPos;
    this.awaitPos = oldAwaitPos || this.awaitPos;
    this.awaitIdentPos = oldAwaitIdentPos || this.awaitIdentPos;
    var node$1 = this.startNodeAt(startPos, startLoc);
    node$1.callee = base;
    node$1.arguments = exprList;
    if (optionalSupported) {
      node$1.optional = optional2;
    }
    base = this.finishNode(node$1, "CallExpression");
  } else if (this.type === types$1.backQuote) {
    if (optional2 || optionalChained) {
      this.raise(this.start, "Optional chaining cannot appear in the tag of tagged template expressions");
    }
    var node$2 = this.startNodeAt(startPos, startLoc);
    node$2.tag = base;
    node$2.quasi = this.parseTemplate({ isTagged: true });
    base = this.finishNode(node$2, "TaggedTemplateExpression");
  }
  return base;
};
pp$5.parseExprAtom = function(refDestructuringErrors, forInit, forNew) {
  if (this.type === types$1.slash) {
    this.readRegexp();
  }
  var node2, canBeArrow = this.potentialArrowAt === this.start;
  switch (this.type) {
    case types$1._super:
      if (!this.allowSuper) {
        this.raise(this.start, "'super' keyword outside a method");
      }
      node2 = this.startNode();
      this.next();
      if (this.type === types$1.parenL && !this.allowDirectSuper) {
        this.raise(node2.start, "super() call outside constructor of a subclass");
      }
      if (this.type !== types$1.dot && this.type !== types$1.bracketL && this.type !== types$1.parenL) {
        this.unexpected();
      }
      return this.finishNode(node2, "Super");
    case types$1._this:
      node2 = this.startNode();
      this.next();
      return this.finishNode(node2, "ThisExpression");
    case types$1.name:
      var startPos = this.start, startLoc = this.startLoc, containsEsc = this.containsEsc;
      var id2 = this.parseIdent(false);
      if (this.options.ecmaVersion >= 8 && !containsEsc && id2.name === "async" && !this.canInsertSemicolon() && this.eat(types$1._function)) {
        this.overrideContext(types.f_expr);
        return this.parseFunction(this.startNodeAt(startPos, startLoc), 0, false, true, forInit);
      }
      if (canBeArrow && !this.canInsertSemicolon()) {
        if (this.eat(types$1.arrow)) {
          return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id2], false, forInit);
        }
        if (this.options.ecmaVersion >= 8 && id2.name === "async" && this.type === types$1.name && !containsEsc && (!this.potentialArrowInForAwait || this.value !== "of" || this.containsEsc)) {
          id2 = this.parseIdent(false);
          if (this.canInsertSemicolon() || !this.eat(types$1.arrow)) {
            this.unexpected();
          }
          return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id2], true, forInit);
        }
      }
      return id2;
    case types$1.regexp:
      var value = this.value;
      node2 = this.parseLiteral(value.value);
      node2.regex = { pattern: value.pattern, flags: value.flags };
      return node2;
    case types$1.num:
    case types$1.string:
      return this.parseLiteral(this.value);
    case types$1._null:
    case types$1._true:
    case types$1._false:
      node2 = this.startNode();
      node2.value = this.type === types$1._null ? null : this.type === types$1._true;
      node2.raw = this.type.keyword;
      this.next();
      return this.finishNode(node2, "Literal");
    case types$1.parenL:
      var start = this.start, expr2 = this.parseParenAndDistinguishExpression(canBeArrow, forInit);
      if (refDestructuringErrors) {
        if (refDestructuringErrors.parenthesizedAssign < 0 && !this.isSimpleAssignTarget(expr2)) {
          refDestructuringErrors.parenthesizedAssign = start;
        }
        if (refDestructuringErrors.parenthesizedBind < 0) {
          refDestructuringErrors.parenthesizedBind = start;
        }
      }
      return expr2;
    case types$1.bracketL:
      node2 = this.startNode();
      this.next();
      node2.elements = this.parseExprList(types$1.bracketR, true, true, refDestructuringErrors);
      return this.finishNode(node2, "ArrayExpression");
    case types$1.braceL:
      this.overrideContext(types.b_expr);
      return this.parseObj(false, refDestructuringErrors);
    case types$1._function:
      node2 = this.startNode();
      this.next();
      return this.parseFunction(node2, 0);
    case types$1._class:
      return this.parseClass(this.startNode(), false);
    case types$1._new:
      return this.parseNew();
    case types$1.backQuote:
      return this.parseTemplate();
    case types$1._import:
      if (this.options.ecmaVersion >= 11) {
        return this.parseExprImport(forNew);
      } else {
        return this.unexpected();
      }
    default:
      return this.parseExprAtomDefault();
  }
};
pp$5.parseExprAtomDefault = function() {
  this.unexpected();
};
pp$5.parseExprImport = function(forNew) {
  var node2 = this.startNode();
  if (this.containsEsc) {
    this.raiseRecoverable(this.start, "Escape sequence in keyword import");
  }
  this.next();
  if (this.type === types$1.parenL && !forNew) {
    return this.parseDynamicImport(node2);
  } else if (this.type === types$1.dot) {
    var meta2 = this.startNodeAt(node2.start, node2.loc && node2.loc.start);
    meta2.name = "import";
    node2.meta = this.finishNode(meta2, "Identifier");
    return this.parseImportMeta(node2);
  } else {
    this.unexpected();
  }
};
pp$5.parseDynamicImport = function(node2) {
  this.next();
  node2.source = this.parseMaybeAssign();
  if (this.options.ecmaVersion >= 16) {
    if (!this.eat(types$1.parenR)) {
      this.expect(types$1.comma);
      if (!this.afterTrailingComma(types$1.parenR)) {
        node2.options = this.parseMaybeAssign();
        if (!this.eat(types$1.parenR)) {
          this.expect(types$1.comma);
          if (!this.afterTrailingComma(types$1.parenR)) {
            this.unexpected();
          }
        }
      } else {
        node2.options = null;
      }
    } else {
      node2.options = null;
    }
  } else {
    if (!this.eat(types$1.parenR)) {
      var errorPos = this.start;
      if (this.eat(types$1.comma) && this.eat(types$1.parenR)) {
        this.raiseRecoverable(errorPos, "Trailing comma is not allowed in import()");
      } else {
        this.unexpected(errorPos);
      }
    }
  }
  return this.finishNode(node2, "ImportExpression");
};
pp$5.parseImportMeta = function(node2) {
  this.next();
  var containsEsc = this.containsEsc;
  node2.property = this.parseIdent(true);
  if (node2.property.name !== "meta") {
    this.raiseRecoverable(node2.property.start, "The only valid meta property for import is 'import.meta'");
  }
  if (containsEsc) {
    this.raiseRecoverable(node2.start, "'import.meta' must not contain escaped characters");
  }
  if (this.options.sourceType !== "module" && !this.options.allowImportExportEverywhere) {
    this.raiseRecoverable(node2.start, "Cannot use 'import.meta' outside a module");
  }
  return this.finishNode(node2, "MetaProperty");
};
pp$5.parseLiteral = function(value) {
  var node2 = this.startNode();
  node2.value = value;
  node2.raw = this.input.slice(this.start, this.end);
  if (node2.raw.charCodeAt(node2.raw.length - 1) === 110) {
    node2.bigint = node2.value != null ? node2.value.toString() : node2.raw.slice(0, -1).replace(/_/g, "");
  }
  this.next();
  return this.finishNode(node2, "Literal");
};
pp$5.parseParenExpression = function() {
  this.expect(types$1.parenL);
  var val = this.parseExpression();
  this.expect(types$1.parenR);
  return val;
};
pp$5.shouldParseArrow = function(exprList) {
  return !this.canInsertSemicolon();
};
pp$5.parseParenAndDistinguishExpression = function(canBeArrow, forInit) {
  var startPos = this.start, startLoc = this.startLoc, val, allowTrailingComma = this.options.ecmaVersion >= 8;
  if (this.options.ecmaVersion >= 6) {
    this.next();
    var innerStartPos = this.start, innerStartLoc = this.startLoc;
    var exprList = [], first = true, lastIsComma = false;
    var refDestructuringErrors = new DestructuringErrors(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, spreadStart;
    this.yieldPos = 0;
    this.awaitPos = 0;
    while (this.type !== types$1.parenR) {
      first ? first = false : this.expect(types$1.comma);
      if (allowTrailingComma && this.afterTrailingComma(types$1.parenR, true)) {
        lastIsComma = true;
        break;
      } else if (this.type === types$1.ellipsis) {
        spreadStart = this.start;
        exprList.push(this.parseParenItem(this.parseRestBinding()));
        if (this.type === types$1.comma) {
          this.raiseRecoverable(
            this.start,
            "Comma is not permitted after the rest element"
          );
        }
        break;
      } else {
        exprList.push(this.parseMaybeAssign(false, refDestructuringErrors, this.parseParenItem));
      }
    }
    var innerEndPos = this.lastTokEnd, innerEndLoc = this.lastTokEndLoc;
    this.expect(types$1.parenR);
    if (canBeArrow && this.shouldParseArrow(exprList) && this.eat(types$1.arrow)) {
      this.checkPatternErrors(refDestructuringErrors, false);
      this.checkYieldAwaitInDefaultParams();
      this.yieldPos = oldYieldPos;
      this.awaitPos = oldAwaitPos;
      return this.parseParenArrowList(startPos, startLoc, exprList, forInit);
    }
    if (!exprList.length || lastIsComma) {
      this.unexpected(this.lastTokStart);
    }
    if (spreadStart) {
      this.unexpected(spreadStart);
    }
    this.checkExpressionErrors(refDestructuringErrors, true);
    this.yieldPos = oldYieldPos || this.yieldPos;
    this.awaitPos = oldAwaitPos || this.awaitPos;
    if (exprList.length > 1) {
      val = this.startNodeAt(innerStartPos, innerStartLoc);
      val.expressions = exprList;
      this.finishNodeAt(val, "SequenceExpression", innerEndPos, innerEndLoc);
    } else {
      val = exprList[0];
    }
  } else {
    val = this.parseParenExpression();
  }
  if (this.options.preserveParens) {
    var par = this.startNodeAt(startPos, startLoc);
    par.expression = val;
    return this.finishNode(par, "ParenthesizedExpression");
  } else {
    return val;
  }
};
pp$5.parseParenItem = function(item) {
  return item;
};
pp$5.parseParenArrowList = function(startPos, startLoc, exprList, forInit) {
  return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, false, forInit);
};
var empty = [];
pp$5.parseNew = function() {
  if (this.containsEsc) {
    this.raiseRecoverable(this.start, "Escape sequence in keyword new");
  }
  var node2 = this.startNode();
  this.next();
  if (this.options.ecmaVersion >= 6 && this.type === types$1.dot) {
    var meta2 = this.startNodeAt(node2.start, node2.loc && node2.loc.start);
    meta2.name = "new";
    node2.meta = this.finishNode(meta2, "Identifier");
    this.next();
    var containsEsc = this.containsEsc;
    node2.property = this.parseIdent(true);
    if (node2.property.name !== "target") {
      this.raiseRecoverable(node2.property.start, "The only valid meta property for new is 'new.target'");
    }
    if (containsEsc) {
      this.raiseRecoverable(node2.start, "'new.target' must not contain escaped characters");
    }
    if (!this.allowNewDotTarget) {
      this.raiseRecoverable(node2.start, "'new.target' can only be used in functions and class static block");
    }
    return this.finishNode(node2, "MetaProperty");
  }
  var startPos = this.start, startLoc = this.startLoc;
  node2.callee = this.parseSubscripts(this.parseExprAtom(null, false, true), startPos, startLoc, true, false);
  if (this.eat(types$1.parenL)) {
    node2.arguments = this.parseExprList(types$1.parenR, this.options.ecmaVersion >= 8, false);
  } else {
    node2.arguments = empty;
  }
  return this.finishNode(node2, "NewExpression");
};
pp$5.parseTemplateElement = function(ref2) {
  var isTagged = ref2.isTagged;
  var elem = this.startNode();
  if (this.type === types$1.invalidTemplate) {
    if (!isTagged) {
      this.raiseRecoverable(this.start, "Bad escape sequence in untagged template literal");
    }
    elem.value = {
      raw: this.value.replace(/\r\n?/g, "\n"),
      cooked: null
    };
  } else {
    elem.value = {
      raw: this.input.slice(this.start, this.end).replace(/\r\n?/g, "\n"),
      cooked: this.value
    };
  }
  this.next();
  elem.tail = this.type === types$1.backQuote;
  return this.finishNode(elem, "TemplateElement");
};
pp$5.parseTemplate = function(ref2) {
  if (ref2 === void 0) ref2 = {};
  var isTagged = ref2.isTagged;
  if (isTagged === void 0) isTagged = false;
  var node2 = this.startNode();
  this.next();
  node2.expressions = [];
  var curElt = this.parseTemplateElement({ isTagged });
  node2.quasis = [curElt];
  while (!curElt.tail) {
    if (this.type === types$1.eof) {
      this.raise(this.pos, "Unterminated template literal");
    }
    this.expect(types$1.dollarBraceL);
    node2.expressions.push(this.parseExpression());
    this.expect(types$1.braceR);
    node2.quasis.push(curElt = this.parseTemplateElement({ isTagged }));
  }
  this.next();
  return this.finishNode(node2, "TemplateLiteral");
};
pp$5.isAsyncProp = function(prop) {
  return !prop.computed && prop.key.type === "Identifier" && prop.key.name === "async" && (this.type === types$1.name || this.type === types$1.num || this.type === types$1.string || this.type === types$1.bracketL || this.type.keyword || this.options.ecmaVersion >= 9 && this.type === types$1.star) && !lineBreak.test(this.input.slice(this.lastTokEnd, this.start));
};
pp$5.parseObj = function(isPattern, refDestructuringErrors) {
  var node2 = this.startNode(), first = true, propHash = {};
  node2.properties = [];
  this.next();
  while (!this.eat(types$1.braceR)) {
    if (!first) {
      this.expect(types$1.comma);
      if (this.options.ecmaVersion >= 5 && this.afterTrailingComma(types$1.braceR)) {
        break;
      }
    } else {
      first = false;
    }
    var prop = this.parseProperty(isPattern, refDestructuringErrors);
    if (!isPattern) {
      this.checkPropClash(prop, propHash, refDestructuringErrors);
    }
    node2.properties.push(prop);
  }
  return this.finishNode(node2, isPattern ? "ObjectPattern" : "ObjectExpression");
};
pp$5.parseProperty = function(isPattern, refDestructuringErrors) {
  var prop = this.startNode(), isGenerator, isAsync, startPos, startLoc;
  if (this.options.ecmaVersion >= 9 && this.eat(types$1.ellipsis)) {
    if (isPattern) {
      prop.argument = this.parseIdent(false);
      if (this.type === types$1.comma) {
        this.raiseRecoverable(this.start, "Comma is not permitted after the rest element");
      }
      return this.finishNode(prop, "RestElement");
    }
    prop.argument = this.parseMaybeAssign(false, refDestructuringErrors);
    if (this.type === types$1.comma && refDestructuringErrors && refDestructuringErrors.trailingComma < 0) {
      refDestructuringErrors.trailingComma = this.start;
    }
    return this.finishNode(prop, "SpreadElement");
  }
  if (this.options.ecmaVersion >= 6) {
    prop.method = false;
    prop.shorthand = false;
    if (isPattern || refDestructuringErrors) {
      startPos = this.start;
      startLoc = this.startLoc;
    }
    if (!isPattern) {
      isGenerator = this.eat(types$1.star);
    }
  }
  var containsEsc = this.containsEsc;
  this.parsePropertyName(prop);
  if (!isPattern && !containsEsc && this.options.ecmaVersion >= 8 && !isGenerator && this.isAsyncProp(prop)) {
    isAsync = true;
    isGenerator = this.options.ecmaVersion >= 9 && this.eat(types$1.star);
    this.parsePropertyName(prop);
  } else {
    isAsync = false;
  }
  this.parsePropertyValue(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc);
  return this.finishNode(prop, "Property");
};
pp$5.parseGetterSetter = function(prop) {
  var kind = prop.key.name;
  this.parsePropertyName(prop);
  prop.value = this.parseMethod(false);
  prop.kind = kind;
  var paramCount = prop.kind === "get" ? 0 : 1;
  if (prop.value.params.length !== paramCount) {
    var start = prop.value.start;
    if (prop.kind === "get") {
      this.raiseRecoverable(start, "getter should have no params");
    } else {
      this.raiseRecoverable(start, "setter should have exactly one param");
    }
  } else {
    if (prop.kind === "set" && prop.value.params[0].type === "RestElement") {
      this.raiseRecoverable(prop.value.params[0].start, "Setter cannot use rest params");
    }
  }
};
pp$5.parsePropertyValue = function(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc) {
  if ((isGenerator || isAsync) && this.type === types$1.colon) {
    this.unexpected();
  }
  if (this.eat(types$1.colon)) {
    prop.value = isPattern ? this.parseMaybeDefault(this.start, this.startLoc) : this.parseMaybeAssign(false, refDestructuringErrors);
    prop.kind = "init";
  } else if (this.options.ecmaVersion >= 6 && this.type === types$1.parenL) {
    if (isPattern) {
      this.unexpected();
    }
    prop.method = true;
    prop.value = this.parseMethod(isGenerator, isAsync);
    prop.kind = "init";
  } else if (!isPattern && !containsEsc && this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === "Identifier" && (prop.key.name === "get" || prop.key.name === "set") && (this.type !== types$1.comma && this.type !== types$1.braceR && this.type !== types$1.eq)) {
    if (isGenerator || isAsync) {
      this.unexpected();
    }
    this.parseGetterSetter(prop);
  } else if (this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === "Identifier") {
    if (isGenerator || isAsync) {
      this.unexpected();
    }
    this.checkUnreserved(prop.key);
    if (prop.key.name === "await" && !this.awaitIdentPos) {
      this.awaitIdentPos = startPos;
    }
    if (isPattern) {
      prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key));
    } else if (this.type === types$1.eq && refDestructuringErrors) {
      if (refDestructuringErrors.shorthandAssign < 0) {
        refDestructuringErrors.shorthandAssign = this.start;
      }
      prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key));
    } else {
      prop.value = this.copyNode(prop.key);
    }
    prop.kind = "init";
    prop.shorthand = true;
  } else {
    this.unexpected();
  }
};
pp$5.parsePropertyName = function(prop) {
  if (this.options.ecmaVersion >= 6) {
    if (this.eat(types$1.bracketL)) {
      prop.computed = true;
      prop.key = this.parseMaybeAssign();
      this.expect(types$1.bracketR);
      return prop.key;
    } else {
      prop.computed = false;
    }
  }
  return prop.key = this.type === types$1.num || this.type === types$1.string ? this.parseExprAtom() : this.parseIdent(this.options.allowReserved !== "never");
};
pp$5.initFunction = function(node2) {
  node2.id = null;
  if (this.options.ecmaVersion >= 6) {
    node2.generator = node2.expression = false;
  }
  if (this.options.ecmaVersion >= 8) {
    node2.async = false;
  }
};
pp$5.parseMethod = function(isGenerator, isAsync, allowDirectSuper) {
  var node2 = this.startNode(), oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
  this.initFunction(node2);
  if (this.options.ecmaVersion >= 6) {
    node2.generator = isGenerator;
  }
  if (this.options.ecmaVersion >= 8) {
    node2.async = !!isAsync;
  }
  this.yieldPos = 0;
  this.awaitPos = 0;
  this.awaitIdentPos = 0;
  this.enterScope(functionFlags(isAsync, node2.generator) | SCOPE_SUPER | (allowDirectSuper ? SCOPE_DIRECT_SUPER : 0));
  this.expect(types$1.parenL);
  node2.params = this.parseBindingList(types$1.parenR, false, this.options.ecmaVersion >= 8);
  this.checkYieldAwaitInDefaultParams();
  this.parseFunctionBody(node2, false, true, false);
  this.yieldPos = oldYieldPos;
  this.awaitPos = oldAwaitPos;
  this.awaitIdentPos = oldAwaitIdentPos;
  return this.finishNode(node2, "FunctionExpression");
};
pp$5.parseArrowExpression = function(node2, params, isAsync, forInit) {
  var oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos;
  this.enterScope(functionFlags(isAsync, false) | SCOPE_ARROW);
  this.initFunction(node2);
  if (this.options.ecmaVersion >= 8) {
    node2.async = !!isAsync;
  }
  this.yieldPos = 0;
  this.awaitPos = 0;
  this.awaitIdentPos = 0;
  node2.params = this.toAssignableList(params, true);
  this.parseFunctionBody(node2, true, false, forInit);
  this.yieldPos = oldYieldPos;
  this.awaitPos = oldAwaitPos;
  this.awaitIdentPos = oldAwaitIdentPos;
  return this.finishNode(node2, "ArrowFunctionExpression");
};
pp$5.parseFunctionBody = function(node2, isArrowFunction, isMethod, forInit) {
  var isExpression = isArrowFunction && this.type !== types$1.braceL;
  var oldStrict = this.strict, useStrict = false;
  if (isExpression) {
    node2.body = this.parseMaybeAssign(forInit);
    node2.expression = true;
    this.checkParams(node2, false);
  } else {
    var nonSimple = this.options.ecmaVersion >= 7 && !this.isSimpleParamList(node2.params);
    if (!oldStrict || nonSimple) {
      useStrict = this.strictDirective(this.end);
      if (useStrict && nonSimple) {
        this.raiseRecoverable(node2.start, "Illegal 'use strict' directive in function with non-simple parameter list");
      }
    }
    var oldLabels = this.labels;
    this.labels = [];
    if (useStrict) {
      this.strict = true;
    }
    this.checkParams(node2, !oldStrict && !useStrict && !isArrowFunction && !isMethod && this.isSimpleParamList(node2.params));
    if (this.strict && node2.id) {
      this.checkLValSimple(node2.id, BIND_OUTSIDE);
    }
    node2.body = this.parseBlock(false, void 0, useStrict && !oldStrict);
    node2.expression = false;
    this.adaptDirectivePrologue(node2.body.body);
    this.labels = oldLabels;
  }
  this.exitScope();
};
pp$5.isSimpleParamList = function(params) {
  for (var i = 0, list = params; i < list.length; i += 1) {
    var param = list[i];
    if (param.type !== "Identifier") {
      return false;
    }
  }
  return true;
};
pp$5.checkParams = function(node2, allowDuplicates) {
  var nameHash = /* @__PURE__ */ Object.create(null);
  for (var i = 0, list = node2.params; i < list.length; i += 1) {
    var param = list[i];
    this.checkLValInnerPattern(param, BIND_VAR, allowDuplicates ? null : nameHash);
  }
};
pp$5.parseExprList = function(close, allowTrailingComma, allowEmpty, refDestructuringErrors) {
  var elts = [], first = true;
  while (!this.eat(close)) {
    if (!first) {
      this.expect(types$1.comma);
      if (allowTrailingComma && this.afterTrailingComma(close)) {
        break;
      }
    } else {
      first = false;
    }
    var elt = void 0;
    if (allowEmpty && this.type === types$1.comma) {
      elt = null;
    } else if (this.type === types$1.ellipsis) {
      elt = this.parseSpread(refDestructuringErrors);
      if (refDestructuringErrors && this.type === types$1.comma && refDestructuringErrors.trailingComma < 0) {
        refDestructuringErrors.trailingComma = this.start;
      }
    } else {
      elt = this.parseMaybeAssign(false, refDestructuringErrors);
    }
    elts.push(elt);
  }
  return elts;
};
pp$5.checkUnreserved = function(ref2) {
  var start = ref2.start;
  var end = ref2.end;
  var name2 = ref2.name;
  if (this.inGenerator && name2 === "yield") {
    this.raiseRecoverable(start, "Cannot use 'yield' as identifier inside a generator");
  }
  if (this.inAsync && name2 === "await") {
    this.raiseRecoverable(start, "Cannot use 'await' as identifier inside an async function");
  }
  if (!(this.currentThisScope().flags & SCOPE_VAR) && name2 === "arguments") {
    this.raiseRecoverable(start, "Cannot use 'arguments' in class field initializer");
  }
  if (this.inClassStaticBlock && (name2 === "arguments" || name2 === "await")) {
    this.raise(start, "Cannot use " + name2 + " in class static initialization block");
  }
  if (this.keywords.test(name2)) {
    this.raise(start, "Unexpected keyword '" + name2 + "'");
  }
  if (this.options.ecmaVersion < 6 && this.input.slice(start, end).indexOf("\\") !== -1) {
    return;
  }
  var re = this.strict ? this.reservedWordsStrict : this.reservedWords;
  if (re.test(name2)) {
    if (!this.inAsync && name2 === "await") {
      this.raiseRecoverable(start, "Cannot use keyword 'await' outside an async function");
    }
    this.raiseRecoverable(start, "The keyword '" + name2 + "' is reserved");
  }
};
pp$5.parseIdent = function(liberal) {
  var node2 = this.parseIdentNode();
  this.next(!!liberal);
  this.finishNode(node2, "Identifier");
  if (!liberal) {
    this.checkUnreserved(node2);
    if (node2.name === "await" && !this.awaitIdentPos) {
      this.awaitIdentPos = node2.start;
    }
  }
  return node2;
};
pp$5.parseIdentNode = function() {
  var node2 = this.startNode();
  if (this.type === types$1.name) {
    node2.name = this.value;
  } else if (this.type.keyword) {
    node2.name = this.type.keyword;
    if ((node2.name === "class" || node2.name === "function") && (this.lastTokEnd !== this.lastTokStart + 1 || this.input.charCodeAt(this.lastTokStart) !== 46)) {
      this.context.pop();
    }
    this.type = types$1.name;
  } else {
    this.unexpected();
  }
  return node2;
};
pp$5.parsePrivateIdent = function() {
  var node2 = this.startNode();
  if (this.type === types$1.privateId) {
    node2.name = this.value;
  } else {
    this.unexpected();
  }
  this.next();
  this.finishNode(node2, "PrivateIdentifier");
  if (this.options.checkPrivateFields) {
    if (this.privateNameStack.length === 0) {
      this.raise(node2.start, "Private field '#" + node2.name + "' must be declared in an enclosing class");
    } else {
      this.privateNameStack[this.privateNameStack.length - 1].used.push(node2);
    }
  }
  return node2;
};
pp$5.parseYield = function(forInit) {
  if (!this.yieldPos) {
    this.yieldPos = this.start;
  }
  var node2 = this.startNode();
  this.next();
  if (this.type === types$1.semi || this.canInsertSemicolon() || this.type !== types$1.star && !this.type.startsExpr) {
    node2.delegate = false;
    node2.argument = null;
  } else {
    node2.delegate = this.eat(types$1.star);
    node2.argument = this.parseMaybeAssign(forInit);
  }
  return this.finishNode(node2, "YieldExpression");
};
pp$5.parseAwait = function(forInit) {
  if (!this.awaitPos) {
    this.awaitPos = this.start;
  }
  var node2 = this.startNode();
  this.next();
  node2.argument = this.parseMaybeUnary(null, true, false, forInit);
  return this.finishNode(node2, "AwaitExpression");
};
var pp$4 = Parser.prototype;
pp$4.raise = function(pos, message) {
  var loc = getLineInfo(this.input, pos);
  message += " (" + loc.line + ":" + loc.column + ")";
  if (this.sourceFile) {
    message += " in " + this.sourceFile;
  }
  var err = new SyntaxError(message);
  err.pos = pos;
  err.loc = loc;
  err.raisedAt = this.pos;
  throw err;
};
pp$4.raiseRecoverable = pp$4.raise;
pp$4.curPosition = function() {
  if (this.options.locations) {
    return new Position(this.curLine, this.pos - this.lineStart);
  }
};
var pp$3 = Parser.prototype;
var Scope = function Scope2(flags) {
  this.flags = flags;
  this.var = [];
  this.lexical = [];
  this.functions = [];
};
pp$3.enterScope = function(flags) {
  this.scopeStack.push(new Scope(flags));
};
pp$3.exitScope = function() {
  this.scopeStack.pop();
};
pp$3.treatFunctionsAsVarInScope = function(scope) {
  return scope.flags & SCOPE_FUNCTION || !this.inModule && scope.flags & SCOPE_TOP;
};
pp$3.declareName = function(name2, bindingType, pos) {
  var redeclared = false;
  if (bindingType === BIND_LEXICAL) {
    var scope = this.currentScope();
    redeclared = scope.lexical.indexOf(name2) > -1 || scope.functions.indexOf(name2) > -1 || scope.var.indexOf(name2) > -1;
    scope.lexical.push(name2);
    if (this.inModule && scope.flags & SCOPE_TOP) {
      delete this.undefinedExports[name2];
    }
  } else if (bindingType === BIND_SIMPLE_CATCH) {
    var scope$1 = this.currentScope();
    scope$1.lexical.push(name2);
  } else if (bindingType === BIND_FUNCTION) {
    var scope$2 = this.currentScope();
    if (this.treatFunctionsAsVar) {
      redeclared = scope$2.lexical.indexOf(name2) > -1;
    } else {
      redeclared = scope$2.lexical.indexOf(name2) > -1 || scope$2.var.indexOf(name2) > -1;
    }
    scope$2.functions.push(name2);
  } else {
    for (var i = this.scopeStack.length - 1; i >= 0; --i) {
      var scope$3 = this.scopeStack[i];
      if (scope$3.lexical.indexOf(name2) > -1 && !(scope$3.flags & SCOPE_SIMPLE_CATCH && scope$3.lexical[0] === name2) || !this.treatFunctionsAsVarInScope(scope$3) && scope$3.functions.indexOf(name2) > -1) {
        redeclared = true;
        break;
      }
      scope$3.var.push(name2);
      if (this.inModule && scope$3.flags & SCOPE_TOP) {
        delete this.undefinedExports[name2];
      }
      if (scope$3.flags & SCOPE_VAR) {
        break;
      }
    }
  }
  if (redeclared) {
    this.raiseRecoverable(pos, "Identifier '" + name2 + "' has already been declared");
  }
};
pp$3.checkLocalExport = function(id2) {
  if (this.scopeStack[0].lexical.indexOf(id2.name) === -1 && this.scopeStack[0].var.indexOf(id2.name) === -1) {
    this.undefinedExports[id2.name] = id2;
  }
};
pp$3.currentScope = function() {
  return this.scopeStack[this.scopeStack.length - 1];
};
pp$3.currentVarScope = function() {
  for (var i = this.scopeStack.length - 1; ; i--) {
    var scope = this.scopeStack[i];
    if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK)) {
      return scope;
    }
  }
};
pp$3.currentThisScope = function() {
  for (var i = this.scopeStack.length - 1; ; i--) {
    var scope = this.scopeStack[i];
    if (scope.flags & (SCOPE_VAR | SCOPE_CLASS_FIELD_INIT | SCOPE_CLASS_STATIC_BLOCK) && !(scope.flags & SCOPE_ARROW)) {
      return scope;
    }
  }
};
var Node = function Node2(parser, pos, loc) {
  this.type = "";
  this.start = pos;
  this.end = 0;
  if (parser.options.locations) {
    this.loc = new SourceLocation(parser, loc);
  }
  if (parser.options.directSourceFile) {
    this.sourceFile = parser.options.directSourceFile;
  }
  if (parser.options.ranges) {
    this.range = [pos, 0];
  }
};
var pp$2 = Parser.prototype;
pp$2.startNode = function() {
  return new Node(this, this.start, this.startLoc);
};
pp$2.startNodeAt = function(pos, loc) {
  return new Node(this, pos, loc);
};
function finishNodeAt(node2, type, pos, loc) {
  node2.type = type;
  node2.end = pos;
  if (this.options.locations) {
    node2.loc.end = loc;
  }
  if (this.options.ranges) {
    node2.range[1] = pos;
  }
  return node2;
}
pp$2.finishNode = function(node2, type) {
  return finishNodeAt.call(this, node2, type, this.lastTokEnd, this.lastTokEndLoc);
};
pp$2.finishNodeAt = function(node2, type, pos, loc) {
  return finishNodeAt.call(this, node2, type, pos, loc);
};
pp$2.copyNode = function(node2) {
  var newNode = new Node(this, node2.start, this.startLoc);
  for (var prop in node2) {
    newNode[prop] = node2[prop];
  }
  return newNode;
};
var scriptValuesAddedInUnicode = "Berf Beria_Erfe Gara Garay Gukh Gurung_Khema Hrkt Katakana_Or_Hiragana Kawi Kirat_Rai Krai Nag_Mundari Nagm Ol_Onal Onao Sidetic Sidt Sunu Sunuwar Tai_Yo Tayo Todhri Todr Tolong_Siki Tols Tulu_Tigalari Tutg Unknown Zzzz";
var ecma9BinaryProperties = "ASCII ASCII_Hex_Digit AHex Alphabetic Alpha Any Assigned Bidi_Control Bidi_C Bidi_Mirrored Bidi_M Case_Ignorable CI Cased Changes_When_Casefolded CWCF Changes_When_Casemapped CWCM Changes_When_Lowercased CWL Changes_When_NFKC_Casefolded CWKCF Changes_When_Titlecased CWT Changes_When_Uppercased CWU Dash Default_Ignorable_Code_Point DI Deprecated Dep Diacritic Dia Emoji Emoji_Component Emoji_Modifier Emoji_Modifier_Base Emoji_Presentation Extender Ext Grapheme_Base Gr_Base Grapheme_Extend Gr_Ext Hex_Digit Hex IDS_Binary_Operator IDSB IDS_Trinary_Operator IDST ID_Continue IDC ID_Start IDS Ideographic Ideo Join_Control Join_C Logical_Order_Exception LOE Lowercase Lower Math Noncharacter_Code_Point NChar Pattern_Syntax Pat_Syn Pattern_White_Space Pat_WS Quotation_Mark QMark Radical Regional_Indicator RI Sentence_Terminal STerm Soft_Dotted SD Terminal_Punctuation Term Unified_Ideograph UIdeo Uppercase Upper Variation_Selector VS White_Space space XID_Continue XIDC XID_Start XIDS";
var ecma10BinaryProperties = ecma9BinaryProperties + " Extended_Pictographic";
var ecma11BinaryProperties = ecma10BinaryProperties;
var ecma12BinaryProperties = ecma11BinaryProperties + " EBase EComp EMod EPres ExtPict";
var ecma13BinaryProperties = ecma12BinaryProperties;
var ecma14BinaryProperties = ecma13BinaryProperties;
var unicodeBinaryProperties = {
  9: ecma9BinaryProperties,
  10: ecma10BinaryProperties,
  11: ecma11BinaryProperties,
  12: ecma12BinaryProperties,
  13: ecma13BinaryProperties,
  14: ecma14BinaryProperties
};
var ecma14BinaryPropertiesOfStrings = "Basic_Emoji Emoji_Keycap_Sequence RGI_Emoji_Modifier_Sequence RGI_Emoji_Flag_Sequence RGI_Emoji_Tag_Sequence RGI_Emoji_ZWJ_Sequence RGI_Emoji";
var unicodeBinaryPropertiesOfStrings = {
  9: "",
  10: "",
  11: "",
  12: "",
  13: "",
  14: ecma14BinaryPropertiesOfStrings
};
var unicodeGeneralCategoryValues = "Cased_Letter LC Close_Punctuation Pe Connector_Punctuation Pc Control Cc cntrl Currency_Symbol Sc Dash_Punctuation Pd Decimal_Number Nd digit Enclosing_Mark Me Final_Punctuation Pf Format Cf Initial_Punctuation Pi Letter L Letter_Number Nl Line_Separator Zl Lowercase_Letter Ll Mark M Combining_Mark Math_Symbol Sm Modifier_Letter Lm Modifier_Symbol Sk Nonspacing_Mark Mn Number N Open_Punctuation Ps Other C Other_Letter Lo Other_Number No Other_Punctuation Po Other_Symbol So Paragraph_Separator Zp Private_Use Co Punctuation P punct Separator Z Space_Separator Zs Spacing_Mark Mc Surrogate Cs Symbol S Titlecase_Letter Lt Unassigned Cn Uppercase_Letter Lu";
var ecma9ScriptValues = "Adlam Adlm Ahom Anatolian_Hieroglyphs Hluw Arabic Arab Armenian Armn Avestan Avst Balinese Bali Bamum Bamu Bassa_Vah Bass Batak Batk Bengali Beng Bhaiksuki Bhks Bopomofo Bopo Brahmi Brah Braille Brai Buginese Bugi Buhid Buhd Canadian_Aboriginal Cans Carian Cari Caucasian_Albanian Aghb Chakma Cakm Cham Cham Cherokee Cher Common Zyyy Coptic Copt Qaac Cuneiform Xsux Cypriot Cprt Cyrillic Cyrl Deseret Dsrt Devanagari Deva Duployan Dupl Egyptian_Hieroglyphs Egyp Elbasan Elba Ethiopic Ethi Georgian Geor Glagolitic Glag Gothic Goth Grantha Gran Greek Grek Gujarati Gujr Gurmukhi Guru Han Hani Hangul Hang Hanunoo Hano Hatran Hatr Hebrew Hebr Hiragana Hira Imperial_Aramaic Armi Inherited Zinh Qaai Inscriptional_Pahlavi Phli Inscriptional_Parthian Prti Javanese Java Kaithi Kthi Kannada Knda Katakana Kana Kayah_Li Kali Kharoshthi Khar Khmer Khmr Khojki Khoj Khudawadi Sind Lao Laoo Latin Latn Lepcha Lepc Limbu Limb Linear_A Lina Linear_B Linb Lisu Lisu Lycian Lyci Lydian Lydi Mahajani Mahj Malayalam Mlym Mandaic Mand Manichaean Mani Marchen Marc Masaram_Gondi Gonm Meetei_Mayek Mtei Mende_Kikakui Mend Meroitic_Cursive Merc Meroitic_Hieroglyphs Mero Miao Plrd Modi Mongolian Mong Mro Mroo Multani Mult Myanmar Mymr Nabataean Nbat New_Tai_Lue Talu Newa Newa Nko Nkoo Nushu Nshu Ogham Ogam Ol_Chiki Olck Old_Hungarian Hung Old_Italic Ital Old_North_Arabian Narb Old_Permic Perm Old_Persian Xpeo Old_South_Arabian Sarb Old_Turkic Orkh Oriya Orya Osage Osge Osmanya Osma Pahawh_Hmong Hmng Palmyrene Palm Pau_Cin_Hau Pauc Phags_Pa Phag Phoenician Phnx Psalter_Pahlavi Phlp Rejang Rjng Runic Runr Samaritan Samr Saurashtra Saur Sharada Shrd Shavian Shaw Siddham Sidd SignWriting Sgnw Sinhala Sinh Sora_Sompeng Sora Soyombo Soyo Sundanese Sund Syloti_Nagri Sylo Syriac Syrc Tagalog Tglg Tagbanwa Tagb Tai_Le Tale Tai_Tham Lana Tai_Viet Tavt Takri Takr Tamil Taml Tangut Tang Telugu Telu Thaana Thaa Thai Thai Tibetan Tibt Tifinagh Tfng Tirhuta Tirh Ugaritic Ugar Vai Vaii Warang_Citi Wara Yi Yiii Zanabazar_Square Zanb";
var ecma10ScriptValues = ecma9ScriptValues + " Dogra Dogr Gunjala_Gondi Gong Hanifi_Rohingya Rohg Makasar Maka Medefaidrin Medf Old_Sogdian Sogo Sogdian Sogd";
var ecma11ScriptValues = ecma10ScriptValues + " Elymaic Elym Nandinagari Nand Nyiakeng_Puachue_Hmong Hmnp Wancho Wcho";
var ecma12ScriptValues = ecma11ScriptValues + " Chorasmian Chrs Diak Dives_Akuru Khitan_Small_Script Kits Yezi Yezidi";
var ecma13ScriptValues = ecma12ScriptValues + " Cypro_Minoan Cpmn Old_Uyghur Ougr Tangsa Tnsa Toto Vithkuqi Vith";
var ecma14ScriptValues = ecma13ScriptValues + " " + scriptValuesAddedInUnicode;
var unicodeScriptValues = {
  9: ecma9ScriptValues,
  10: ecma10ScriptValues,
  11: ecma11ScriptValues,
  12: ecma12ScriptValues,
  13: ecma13ScriptValues,
  14: ecma14ScriptValues
};
var data = {};
function buildUnicodeData(ecmaVersion) {
  var d = data[ecmaVersion] = {
    binary: wordsRegexp(unicodeBinaryProperties[ecmaVersion] + " " + unicodeGeneralCategoryValues),
    binaryOfStrings: wordsRegexp(unicodeBinaryPropertiesOfStrings[ecmaVersion]),
    nonBinary: {
      General_Category: wordsRegexp(unicodeGeneralCategoryValues),
      Script: wordsRegexp(unicodeScriptValues[ecmaVersion])
    }
  };
  d.nonBinary.Script_Extensions = d.nonBinary.Script;
  d.nonBinary.gc = d.nonBinary.General_Category;
  d.nonBinary.sc = d.nonBinary.Script;
  d.nonBinary.scx = d.nonBinary.Script_Extensions;
}
for (i = 0, list = [9, 10, 11, 12, 13, 14]; i < list.length; i += 1) {
  ecmaVersion = list[i];
  buildUnicodeData(ecmaVersion);
}
var ecmaVersion;
var i;
var list;
var pp$1 = Parser.prototype;
var BranchID = function BranchID2(parent, base) {
  this.parent = parent;
  this.base = base || this;
};
BranchID.prototype.separatedFrom = function separatedFrom(alt) {
  for (var self = this; self; self = self.parent) {
    for (var other = alt; other; other = other.parent) {
      if (self.base === other.base && self !== other) {
        return true;
      }
    }
  }
  return false;
};
BranchID.prototype.sibling = function sibling() {
  return new BranchID(this.parent, this.base);
};
var RegExpValidationState = function RegExpValidationState2(parser) {
  this.parser = parser;
  this.validFlags = "gim" + (parser.options.ecmaVersion >= 6 ? "uy" : "") + (parser.options.ecmaVersion >= 9 ? "s" : "") + (parser.options.ecmaVersion >= 13 ? "d" : "") + (parser.options.ecmaVersion >= 15 ? "v" : "");
  this.unicodeProperties = data[parser.options.ecmaVersion >= 14 ? 14 : parser.options.ecmaVersion];
  this.source = "";
  this.flags = "";
  this.start = 0;
  this.switchU = false;
  this.switchV = false;
  this.switchN = false;
  this.pos = 0;
  this.lastIntValue = 0;
  this.lastStringValue = "";
  this.lastAssertionIsQuantifiable = false;
  this.numCapturingParens = 0;
  this.maxBackReference = 0;
  this.groupNames = /* @__PURE__ */ Object.create(null);
  this.backReferenceNames = [];
  this.branchID = null;
};
RegExpValidationState.prototype.reset = function reset(start, pattern, flags) {
  var unicodeSets = flags.indexOf("v") !== -1;
  var unicode = flags.indexOf("u") !== -1;
  this.start = start | 0;
  this.source = pattern + "";
  this.flags = flags;
  if (unicodeSets && this.parser.options.ecmaVersion >= 15) {
    this.switchU = true;
    this.switchV = true;
    this.switchN = true;
  } else {
    this.switchU = unicode && this.parser.options.ecmaVersion >= 6;
    this.switchV = false;
    this.switchN = unicode && this.parser.options.ecmaVersion >= 9;
  }
};
RegExpValidationState.prototype.raise = function raise(message) {
  this.parser.raiseRecoverable(this.start, "Invalid regular expression: /" + this.source + "/: " + message);
};
RegExpValidationState.prototype.at = function at(i, forceU) {
  if (forceU === void 0) forceU = false;
  var s = this.source;
  var l = s.length;
  if (i >= l) {
    return -1;
  }
  var c = s.charCodeAt(i);
  if (!(forceU || this.switchU) || c <= 55295 || c >= 57344 || i + 1 >= l) {
    return c;
  }
  var next = s.charCodeAt(i + 1);
  return next >= 56320 && next <= 57343 ? (c << 10) + next - 56613888 : c;
};
RegExpValidationState.prototype.nextIndex = function nextIndex(i, forceU) {
  if (forceU === void 0) forceU = false;
  var s = this.source;
  var l = s.length;
  if (i >= l) {
    return l;
  }
  var c = s.charCodeAt(i), next;
  if (!(forceU || this.switchU) || c <= 55295 || c >= 57344 || i + 1 >= l || (next = s.charCodeAt(i + 1)) < 56320 || next > 57343) {
    return i + 1;
  }
  return i + 2;
};
RegExpValidationState.prototype.current = function current(forceU) {
  if (forceU === void 0) forceU = false;
  return this.at(this.pos, forceU);
};
RegExpValidationState.prototype.lookahead = function lookahead(forceU) {
  if (forceU === void 0) forceU = false;
  return this.at(this.nextIndex(this.pos, forceU), forceU);
};
RegExpValidationState.prototype.advance = function advance(forceU) {
  if (forceU === void 0) forceU = false;
  this.pos = this.nextIndex(this.pos, forceU);
};
RegExpValidationState.prototype.eat = function eat(ch, forceU) {
  if (forceU === void 0) forceU = false;
  if (this.current(forceU) === ch) {
    this.advance(forceU);
    return true;
  }
  return false;
};
RegExpValidationState.prototype.eatChars = function eatChars(chs, forceU) {
  if (forceU === void 0) forceU = false;
  var pos = this.pos;
  for (var i = 0, list = chs; i < list.length; i += 1) {
    var ch = list[i];
    var current2 = this.at(pos, forceU);
    if (current2 === -1 || current2 !== ch) {
      return false;
    }
    pos = this.nextIndex(pos, forceU);
  }
  this.pos = pos;
  return true;
};
pp$1.validateRegExpFlags = function(state) {
  var validFlags = state.validFlags;
  var flags = state.flags;
  var u = false;
  var v = false;
  for (var i = 0; i < flags.length; i++) {
    var flag = flags.charAt(i);
    if (validFlags.indexOf(flag) === -1) {
      this.raise(state.start, "Invalid regular expression flag");
    }
    if (flags.indexOf(flag, i + 1) > -1) {
      this.raise(state.start, "Duplicate regular expression flag");
    }
    if (flag === "u") {
      u = true;
    }
    if (flag === "v") {
      v = true;
    }
  }
  if (this.options.ecmaVersion >= 15 && u && v) {
    this.raise(state.start, "Invalid regular expression flag");
  }
};
function hasProp(obj) {
  for (var _ in obj) {
    return true;
  }
  return false;
}
pp$1.validateRegExpPattern = function(state) {
  this.regexp_pattern(state);
  if (!state.switchN && this.options.ecmaVersion >= 9 && hasProp(state.groupNames)) {
    state.switchN = true;
    this.regexp_pattern(state);
  }
};
pp$1.regexp_pattern = function(state) {
  state.pos = 0;
  state.lastIntValue = 0;
  state.lastStringValue = "";
  state.lastAssertionIsQuantifiable = false;
  state.numCapturingParens = 0;
  state.maxBackReference = 0;
  state.groupNames = /* @__PURE__ */ Object.create(null);
  state.backReferenceNames.length = 0;
  state.branchID = null;
  this.regexp_disjunction(state);
  if (state.pos !== state.source.length) {
    if (state.eat(
      41
      /* ) */
    )) {
      state.raise("Unmatched ')'");
    }
    if (state.eat(
      93
      /* ] */
    ) || state.eat(
      125
      /* } */
    )) {
      state.raise("Lone quantifier brackets");
    }
  }
  if (state.maxBackReference > state.numCapturingParens) {
    state.raise("Invalid escape");
  }
  for (var i = 0, list = state.backReferenceNames; i < list.length; i += 1) {
    var name2 = list[i];
    if (!state.groupNames[name2]) {
      state.raise("Invalid named capture referenced");
    }
  }
};
pp$1.regexp_disjunction = function(state) {
  var trackDisjunction = this.options.ecmaVersion >= 16;
  if (trackDisjunction) {
    state.branchID = new BranchID(state.branchID, null);
  }
  this.regexp_alternative(state);
  while (state.eat(
    124
    /* | */
  )) {
    if (trackDisjunction) {
      state.branchID = state.branchID.sibling();
    }
    this.regexp_alternative(state);
  }
  if (trackDisjunction) {
    state.branchID = state.branchID.parent;
  }
  if (this.regexp_eatQuantifier(state, true)) {
    state.raise("Nothing to repeat");
  }
  if (state.eat(
    123
    /* { */
  )) {
    state.raise("Lone quantifier brackets");
  }
};
pp$1.regexp_alternative = function(state) {
  while (state.pos < state.source.length && this.regexp_eatTerm(state)) {
  }
};
pp$1.regexp_eatTerm = function(state) {
  if (this.regexp_eatAssertion(state)) {
    if (state.lastAssertionIsQuantifiable && this.regexp_eatQuantifier(state)) {
      if (state.switchU) {
        state.raise("Invalid quantifier");
      }
    }
    return true;
  }
  if (state.switchU ? this.regexp_eatAtom(state) : this.regexp_eatExtendedAtom(state)) {
    this.regexp_eatQuantifier(state);
    return true;
  }
  return false;
};
pp$1.regexp_eatAssertion = function(state) {
  var start = state.pos;
  state.lastAssertionIsQuantifiable = false;
  if (state.eat(
    94
    /* ^ */
  ) || state.eat(
    36
    /* $ */
  )) {
    return true;
  }
  if (state.eat(
    92
    /* \ */
  )) {
    if (state.eat(
      66
      /* B */
    ) || state.eat(
      98
      /* b */
    )) {
      return true;
    }
    state.pos = start;
  }
  if (state.eat(
    40
    /* ( */
  ) && state.eat(
    63
    /* ? */
  )) {
    var lookbehind = false;
    if (this.options.ecmaVersion >= 9) {
      lookbehind = state.eat(
        60
        /* < */
      );
    }
    if (state.eat(
      61
      /* = */
    ) || state.eat(
      33
      /* ! */
    )) {
      this.regexp_disjunction(state);
      if (!state.eat(
        41
        /* ) */
      )) {
        state.raise("Unterminated group");
      }
      state.lastAssertionIsQuantifiable = !lookbehind;
      return true;
    }
  }
  state.pos = start;
  return false;
};
pp$1.regexp_eatQuantifier = function(state, noError) {
  if (noError === void 0) noError = false;
  if (this.regexp_eatQuantifierPrefix(state, noError)) {
    state.eat(
      63
      /* ? */
    );
    return true;
  }
  return false;
};
pp$1.regexp_eatQuantifierPrefix = function(state, noError) {
  return state.eat(
    42
    /* * */
  ) || state.eat(
    43
    /* + */
  ) || state.eat(
    63
    /* ? */
  ) || this.regexp_eatBracedQuantifier(state, noError);
};
pp$1.regexp_eatBracedQuantifier = function(state, noError) {
  var start = state.pos;
  if (state.eat(
    123
    /* { */
  )) {
    var min = 0, max = -1;
    if (this.regexp_eatDecimalDigits(state)) {
      min = state.lastIntValue;
      if (state.eat(
        44
        /* , */
      ) && this.regexp_eatDecimalDigits(state)) {
        max = state.lastIntValue;
      }
      if (state.eat(
        125
        /* } */
      )) {
        if (max !== -1 && max < min && !noError) {
          state.raise("numbers out of order in {} quantifier");
        }
        return true;
      }
    }
    if (state.switchU && !noError) {
      state.raise("Incomplete quantifier");
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatAtom = function(state) {
  return this.regexp_eatPatternCharacters(state) || state.eat(
    46
    /* . */
  ) || this.regexp_eatReverseSolidusAtomEscape(state) || this.regexp_eatCharacterClass(state) || this.regexp_eatUncapturingGroup(state) || this.regexp_eatCapturingGroup(state);
};
pp$1.regexp_eatReverseSolidusAtomEscape = function(state) {
  var start = state.pos;
  if (state.eat(
    92
    /* \ */
  )) {
    if (this.regexp_eatAtomEscape(state)) {
      return true;
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatUncapturingGroup = function(state) {
  var start = state.pos;
  if (state.eat(
    40
    /* ( */
  )) {
    if (state.eat(
      63
      /* ? */
    )) {
      if (this.options.ecmaVersion >= 16) {
        var addModifiers = this.regexp_eatModifiers(state);
        var hasHyphen = state.eat(
          45
          /* - */
        );
        if (addModifiers || hasHyphen) {
          for (var i = 0; i < addModifiers.length; i++) {
            var modifier = addModifiers.charAt(i);
            if (addModifiers.indexOf(modifier, i + 1) > -1) {
              state.raise("Duplicate regular expression modifiers");
            }
          }
          if (hasHyphen) {
            var removeModifiers = this.regexp_eatModifiers(state);
            if (!addModifiers && !removeModifiers && state.current() === 58) {
              state.raise("Invalid regular expression modifiers");
            }
            for (var i$1 = 0; i$1 < removeModifiers.length; i$1++) {
              var modifier$1 = removeModifiers.charAt(i$1);
              if (removeModifiers.indexOf(modifier$1, i$1 + 1) > -1 || addModifiers.indexOf(modifier$1) > -1) {
                state.raise("Duplicate regular expression modifiers");
              }
            }
          }
        }
      }
      if (state.eat(
        58
        /* : */
      )) {
        this.regexp_disjunction(state);
        if (state.eat(
          41
          /* ) */
        )) {
          return true;
        }
        state.raise("Unterminated group");
      }
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatCapturingGroup = function(state) {
  if (state.eat(
    40
    /* ( */
  )) {
    if (this.options.ecmaVersion >= 9) {
      this.regexp_groupSpecifier(state);
    } else if (state.current() === 63) {
      state.raise("Invalid group");
    }
    this.regexp_disjunction(state);
    if (state.eat(
      41
      /* ) */
    )) {
      state.numCapturingParens += 1;
      return true;
    }
    state.raise("Unterminated group");
  }
  return false;
};
pp$1.regexp_eatModifiers = function(state) {
  var modifiers = "";
  var ch = 0;
  while ((ch = state.current()) !== -1 && isRegularExpressionModifier(ch)) {
    modifiers += codePointToString(ch);
    state.advance();
  }
  return modifiers;
};
function isRegularExpressionModifier(ch) {
  return ch === 105 || ch === 109 || ch === 115;
}
pp$1.regexp_eatExtendedAtom = function(state) {
  return state.eat(
    46
    /* . */
  ) || this.regexp_eatReverseSolidusAtomEscape(state) || this.regexp_eatCharacterClass(state) || this.regexp_eatUncapturingGroup(state) || this.regexp_eatCapturingGroup(state) || this.regexp_eatInvalidBracedQuantifier(state) || this.regexp_eatExtendedPatternCharacter(state);
};
pp$1.regexp_eatInvalidBracedQuantifier = function(state) {
  if (this.regexp_eatBracedQuantifier(state, true)) {
    state.raise("Nothing to repeat");
  }
  return false;
};
pp$1.regexp_eatSyntaxCharacter = function(state) {
  var ch = state.current();
  if (isSyntaxCharacter(ch)) {
    state.lastIntValue = ch;
    state.advance();
    return true;
  }
  return false;
};
function isSyntaxCharacter(ch) {
  return ch === 36 || ch >= 40 && ch <= 43 || ch === 46 || ch === 63 || ch >= 91 && ch <= 94 || ch >= 123 && ch <= 125;
}
pp$1.regexp_eatPatternCharacters = function(state) {
  var start = state.pos;
  var ch = 0;
  while ((ch = state.current()) !== -1 && !isSyntaxCharacter(ch)) {
    state.advance();
  }
  return state.pos !== start;
};
pp$1.regexp_eatExtendedPatternCharacter = function(state) {
  var ch = state.current();
  if (ch !== -1 && ch !== 36 && !(ch >= 40 && ch <= 43) && ch !== 46 && ch !== 63 && ch !== 91 && ch !== 94 && ch !== 124) {
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_groupSpecifier = function(state) {
  if (state.eat(
    63
    /* ? */
  )) {
    if (!this.regexp_eatGroupName(state)) {
      state.raise("Invalid group");
    }
    var trackDisjunction = this.options.ecmaVersion >= 16;
    var known = state.groupNames[state.lastStringValue];
    if (known) {
      if (trackDisjunction) {
        for (var i = 0, list = known; i < list.length; i += 1) {
          var altID = list[i];
          if (!altID.separatedFrom(state.branchID)) {
            state.raise("Duplicate capture group name");
          }
        }
      } else {
        state.raise("Duplicate capture group name");
      }
    }
    if (trackDisjunction) {
      (known || (state.groupNames[state.lastStringValue] = [])).push(state.branchID);
    } else {
      state.groupNames[state.lastStringValue] = true;
    }
  }
};
pp$1.regexp_eatGroupName = function(state) {
  state.lastStringValue = "";
  if (state.eat(
    60
    /* < */
  )) {
    if (this.regexp_eatRegExpIdentifierName(state) && state.eat(
      62
      /* > */
    )) {
      return true;
    }
    state.raise("Invalid capture group name");
  }
  return false;
};
pp$1.regexp_eatRegExpIdentifierName = function(state) {
  state.lastStringValue = "";
  if (this.regexp_eatRegExpIdentifierStart(state)) {
    state.lastStringValue += codePointToString(state.lastIntValue);
    while (this.regexp_eatRegExpIdentifierPart(state)) {
      state.lastStringValue += codePointToString(state.lastIntValue);
    }
    return true;
  }
  return false;
};
pp$1.regexp_eatRegExpIdentifierStart = function(state) {
  var start = state.pos;
  var forceU = this.options.ecmaVersion >= 11;
  var ch = state.current(forceU);
  state.advance(forceU);
  if (ch === 92 && this.regexp_eatRegExpUnicodeEscapeSequence(state, forceU)) {
    ch = state.lastIntValue;
  }
  if (isRegExpIdentifierStart(ch)) {
    state.lastIntValue = ch;
    return true;
  }
  state.pos = start;
  return false;
};
function isRegExpIdentifierStart(ch) {
  return isIdentifierStart(ch, true) || ch === 36 || ch === 95;
}
pp$1.regexp_eatRegExpIdentifierPart = function(state) {
  var start = state.pos;
  var forceU = this.options.ecmaVersion >= 11;
  var ch = state.current(forceU);
  state.advance(forceU);
  if (ch === 92 && this.regexp_eatRegExpUnicodeEscapeSequence(state, forceU)) {
    ch = state.lastIntValue;
  }
  if (isRegExpIdentifierPart(ch)) {
    state.lastIntValue = ch;
    return true;
  }
  state.pos = start;
  return false;
};
function isRegExpIdentifierPart(ch) {
  return isIdentifierChar(ch, true) || ch === 36 || ch === 95 || ch === 8204 || ch === 8205;
}
pp$1.regexp_eatAtomEscape = function(state) {
  if (this.regexp_eatBackReference(state) || this.regexp_eatCharacterClassEscape(state) || this.regexp_eatCharacterEscape(state) || state.switchN && this.regexp_eatKGroupName(state)) {
    return true;
  }
  if (state.switchU) {
    if (state.current() === 99) {
      state.raise("Invalid unicode escape");
    }
    state.raise("Invalid escape");
  }
  return false;
};
pp$1.regexp_eatBackReference = function(state) {
  var start = state.pos;
  if (this.regexp_eatDecimalEscape(state)) {
    var n = state.lastIntValue;
    if (state.switchU) {
      if (n > state.maxBackReference) {
        state.maxBackReference = n;
      }
      return true;
    }
    if (n <= state.numCapturingParens) {
      return true;
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatKGroupName = function(state) {
  if (state.eat(
    107
    /* k */
  )) {
    if (this.regexp_eatGroupName(state)) {
      state.backReferenceNames.push(state.lastStringValue);
      return true;
    }
    state.raise("Invalid named reference");
  }
  return false;
};
pp$1.regexp_eatCharacterEscape = function(state) {
  return this.regexp_eatControlEscape(state) || this.regexp_eatCControlLetter(state) || this.regexp_eatZero(state) || this.regexp_eatHexEscapeSequence(state) || this.regexp_eatRegExpUnicodeEscapeSequence(state, false) || !state.switchU && this.regexp_eatLegacyOctalEscapeSequence(state) || this.regexp_eatIdentityEscape(state);
};
pp$1.regexp_eatCControlLetter = function(state) {
  var start = state.pos;
  if (state.eat(
    99
    /* c */
  )) {
    if (this.regexp_eatControlLetter(state)) {
      return true;
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatZero = function(state) {
  if (state.current() === 48 && !isDecimalDigit(state.lookahead())) {
    state.lastIntValue = 0;
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_eatControlEscape = function(state) {
  var ch = state.current();
  if (ch === 116) {
    state.lastIntValue = 9;
    state.advance();
    return true;
  }
  if (ch === 110) {
    state.lastIntValue = 10;
    state.advance();
    return true;
  }
  if (ch === 118) {
    state.lastIntValue = 11;
    state.advance();
    return true;
  }
  if (ch === 102) {
    state.lastIntValue = 12;
    state.advance();
    return true;
  }
  if (ch === 114) {
    state.lastIntValue = 13;
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_eatControlLetter = function(state) {
  var ch = state.current();
  if (isControlLetter(ch)) {
    state.lastIntValue = ch % 32;
    state.advance();
    return true;
  }
  return false;
};
function isControlLetter(ch) {
  return ch >= 65 && ch <= 90 || ch >= 97 && ch <= 122;
}
pp$1.regexp_eatRegExpUnicodeEscapeSequence = function(state, forceU) {
  if (forceU === void 0) forceU = false;
  var start = state.pos;
  var switchU = forceU || state.switchU;
  if (state.eat(
    117
    /* u */
  )) {
    if (this.regexp_eatFixedHexDigits(state, 4)) {
      var lead = state.lastIntValue;
      if (switchU && lead >= 55296 && lead <= 56319) {
        var leadSurrogateEnd = state.pos;
        if (state.eat(
          92
          /* \ */
        ) && state.eat(
          117
          /* u */
        ) && this.regexp_eatFixedHexDigits(state, 4)) {
          var trail = state.lastIntValue;
          if (trail >= 56320 && trail <= 57343) {
            state.lastIntValue = (lead - 55296) * 1024 + (trail - 56320) + 65536;
            return true;
          }
        }
        state.pos = leadSurrogateEnd;
        state.lastIntValue = lead;
      }
      return true;
    }
    if (switchU && state.eat(
      123
      /* { */
    ) && this.regexp_eatHexDigits(state) && state.eat(
      125
      /* } */
    ) && isValidUnicode(state.lastIntValue)) {
      return true;
    }
    if (switchU) {
      state.raise("Invalid unicode escape");
    }
    state.pos = start;
  }
  return false;
};
function isValidUnicode(ch) {
  return ch >= 0 && ch <= 1114111;
}
pp$1.regexp_eatIdentityEscape = function(state) {
  if (state.switchU) {
    if (this.regexp_eatSyntaxCharacter(state)) {
      return true;
    }
    if (state.eat(
      47
      /* / */
    )) {
      state.lastIntValue = 47;
      return true;
    }
    return false;
  }
  var ch = state.current();
  if (ch !== 99 && (!state.switchN || ch !== 107)) {
    state.lastIntValue = ch;
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_eatDecimalEscape = function(state) {
  state.lastIntValue = 0;
  var ch = state.current();
  if (ch >= 49 && ch <= 57) {
    do {
      state.lastIntValue = 10 * state.lastIntValue + (ch - 48);
      state.advance();
    } while ((ch = state.current()) >= 48 && ch <= 57);
    return true;
  }
  return false;
};
var CharSetNone = 0;
var CharSetOk = 1;
var CharSetString = 2;
pp$1.regexp_eatCharacterClassEscape = function(state) {
  var ch = state.current();
  if (isCharacterClassEscape(ch)) {
    state.lastIntValue = -1;
    state.advance();
    return CharSetOk;
  }
  var negate = false;
  if (state.switchU && this.options.ecmaVersion >= 9 && ((negate = ch === 80) || ch === 112)) {
    state.lastIntValue = -1;
    state.advance();
    var result;
    if (state.eat(
      123
      /* { */
    ) && (result = this.regexp_eatUnicodePropertyValueExpression(state)) && state.eat(
      125
      /* } */
    )) {
      if (negate && result === CharSetString) {
        state.raise("Invalid property name");
      }
      return result;
    }
    state.raise("Invalid property name");
  }
  return CharSetNone;
};
function isCharacterClassEscape(ch) {
  return ch === 100 || ch === 68 || ch === 115 || ch === 83 || ch === 119 || ch === 87;
}
pp$1.regexp_eatUnicodePropertyValueExpression = function(state) {
  var start = state.pos;
  if (this.regexp_eatUnicodePropertyName(state) && state.eat(
    61
    /* = */
  )) {
    var name2 = state.lastStringValue;
    if (this.regexp_eatUnicodePropertyValue(state)) {
      var value = state.lastStringValue;
      this.regexp_validateUnicodePropertyNameAndValue(state, name2, value);
      return CharSetOk;
    }
  }
  state.pos = start;
  if (this.regexp_eatLoneUnicodePropertyNameOrValue(state)) {
    var nameOrValue = state.lastStringValue;
    return this.regexp_validateUnicodePropertyNameOrValue(state, nameOrValue);
  }
  return CharSetNone;
};
pp$1.regexp_validateUnicodePropertyNameAndValue = function(state, name2, value) {
  if (!hasOwn(state.unicodeProperties.nonBinary, name2)) {
    state.raise("Invalid property name");
  }
  if (!state.unicodeProperties.nonBinary[name2].test(value)) {
    state.raise("Invalid property value");
  }
};
pp$1.regexp_validateUnicodePropertyNameOrValue = function(state, nameOrValue) {
  if (state.unicodeProperties.binary.test(nameOrValue)) {
    return CharSetOk;
  }
  if (state.switchV && state.unicodeProperties.binaryOfStrings.test(nameOrValue)) {
    return CharSetString;
  }
  state.raise("Invalid property name");
};
pp$1.regexp_eatUnicodePropertyName = function(state) {
  var ch = 0;
  state.lastStringValue = "";
  while (isUnicodePropertyNameCharacter(ch = state.current())) {
    state.lastStringValue += codePointToString(ch);
    state.advance();
  }
  return state.lastStringValue !== "";
};
function isUnicodePropertyNameCharacter(ch) {
  return isControlLetter(ch) || ch === 95;
}
pp$1.regexp_eatUnicodePropertyValue = function(state) {
  var ch = 0;
  state.lastStringValue = "";
  while (isUnicodePropertyValueCharacter(ch = state.current())) {
    state.lastStringValue += codePointToString(ch);
    state.advance();
  }
  return state.lastStringValue !== "";
};
function isUnicodePropertyValueCharacter(ch) {
  return isUnicodePropertyNameCharacter(ch) || isDecimalDigit(ch);
}
pp$1.regexp_eatLoneUnicodePropertyNameOrValue = function(state) {
  return this.regexp_eatUnicodePropertyValue(state);
};
pp$1.regexp_eatCharacterClass = function(state) {
  if (state.eat(
    91
    /* [ */
  )) {
    var negate = state.eat(
      94
      /* ^ */
    );
    var result = this.regexp_classContents(state);
    if (!state.eat(
      93
      /* ] */
    )) {
      state.raise("Unterminated character class");
    }
    if (negate && result === CharSetString) {
      state.raise("Negated character class may contain strings");
    }
    return true;
  }
  return false;
};
pp$1.regexp_classContents = function(state) {
  if (state.current() === 93) {
    return CharSetOk;
  }
  if (state.switchV) {
    return this.regexp_classSetExpression(state);
  }
  this.regexp_nonEmptyClassRanges(state);
  return CharSetOk;
};
pp$1.regexp_nonEmptyClassRanges = function(state) {
  while (this.regexp_eatClassAtom(state)) {
    var left = state.lastIntValue;
    if (state.eat(
      45
      /* - */
    ) && this.regexp_eatClassAtom(state)) {
      var right = state.lastIntValue;
      if (state.switchU && (left === -1 || right === -1)) {
        state.raise("Invalid character class");
      }
      if (left !== -1 && right !== -1 && left > right) {
        state.raise("Range out of order in character class");
      }
    }
  }
};
pp$1.regexp_eatClassAtom = function(state) {
  var start = state.pos;
  if (state.eat(
    92
    /* \ */
  )) {
    if (this.regexp_eatClassEscape(state)) {
      return true;
    }
    if (state.switchU) {
      var ch$1 = state.current();
      if (ch$1 === 99 || isOctalDigit(ch$1)) {
        state.raise("Invalid class escape");
      }
      state.raise("Invalid escape");
    }
    state.pos = start;
  }
  var ch = state.current();
  if (ch !== 93) {
    state.lastIntValue = ch;
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_eatClassEscape = function(state) {
  var start = state.pos;
  if (state.eat(
    98
    /* b */
  )) {
    state.lastIntValue = 8;
    return true;
  }
  if (state.switchU && state.eat(
    45
    /* - */
  )) {
    state.lastIntValue = 45;
    return true;
  }
  if (!state.switchU && state.eat(
    99
    /* c */
  )) {
    if (this.regexp_eatClassControlLetter(state)) {
      return true;
    }
    state.pos = start;
  }
  return this.regexp_eatCharacterClassEscape(state) || this.regexp_eatCharacterEscape(state);
};
pp$1.regexp_classSetExpression = function(state) {
  var result = CharSetOk, subResult;
  if (this.regexp_eatClassSetRange(state)) ;
  else if (subResult = this.regexp_eatClassSetOperand(state)) {
    if (subResult === CharSetString) {
      result = CharSetString;
    }
    var start = state.pos;
    while (state.eatChars(
      [38, 38]
      /* && */
    )) {
      if (state.current() !== 38 && (subResult = this.regexp_eatClassSetOperand(state))) {
        if (subResult !== CharSetString) {
          result = CharSetOk;
        }
        continue;
      }
      state.raise("Invalid character in character class");
    }
    if (start !== state.pos) {
      return result;
    }
    while (state.eatChars(
      [45, 45]
      /* -- */
    )) {
      if (this.regexp_eatClassSetOperand(state)) {
        continue;
      }
      state.raise("Invalid character in character class");
    }
    if (start !== state.pos) {
      return result;
    }
  } else {
    state.raise("Invalid character in character class");
  }
  for (; ; ) {
    if (this.regexp_eatClassSetRange(state)) {
      continue;
    }
    subResult = this.regexp_eatClassSetOperand(state);
    if (!subResult) {
      return result;
    }
    if (subResult === CharSetString) {
      result = CharSetString;
    }
  }
};
pp$1.regexp_eatClassSetRange = function(state) {
  var start = state.pos;
  if (this.regexp_eatClassSetCharacter(state)) {
    var left = state.lastIntValue;
    if (state.eat(
      45
      /* - */
    ) && this.regexp_eatClassSetCharacter(state)) {
      var right = state.lastIntValue;
      if (left !== -1 && right !== -1 && left > right) {
        state.raise("Range out of order in character class");
      }
      return true;
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatClassSetOperand = function(state) {
  if (this.regexp_eatClassSetCharacter(state)) {
    return CharSetOk;
  }
  return this.regexp_eatClassStringDisjunction(state) || this.regexp_eatNestedClass(state);
};
pp$1.regexp_eatNestedClass = function(state) {
  var start = state.pos;
  if (state.eat(
    91
    /* [ */
  )) {
    var negate = state.eat(
      94
      /* ^ */
    );
    var result = this.regexp_classContents(state);
    if (state.eat(
      93
      /* ] */
    )) {
      if (negate && result === CharSetString) {
        state.raise("Negated character class may contain strings");
      }
      return result;
    }
    state.pos = start;
  }
  if (state.eat(
    92
    /* \ */
  )) {
    var result$1 = this.regexp_eatCharacterClassEscape(state);
    if (result$1) {
      return result$1;
    }
    state.pos = start;
  }
  return null;
};
pp$1.regexp_eatClassStringDisjunction = function(state) {
  var start = state.pos;
  if (state.eatChars(
    [92, 113]
    /* \q */
  )) {
    if (state.eat(
      123
      /* { */
    )) {
      var result = this.regexp_classStringDisjunctionContents(state);
      if (state.eat(
        125
        /* } */
      )) {
        return result;
      }
    } else {
      state.raise("Invalid escape");
    }
    state.pos = start;
  }
  return null;
};
pp$1.regexp_classStringDisjunctionContents = function(state) {
  var result = this.regexp_classString(state);
  while (state.eat(
    124
    /* | */
  )) {
    if (this.regexp_classString(state) === CharSetString) {
      result = CharSetString;
    }
  }
  return result;
};
pp$1.regexp_classString = function(state) {
  var count = 0;
  while (this.regexp_eatClassSetCharacter(state)) {
    count++;
  }
  return count === 1 ? CharSetOk : CharSetString;
};
pp$1.regexp_eatClassSetCharacter = function(state) {
  var start = state.pos;
  if (state.eat(
    92
    /* \ */
  )) {
    if (this.regexp_eatCharacterEscape(state) || this.regexp_eatClassSetReservedPunctuator(state)) {
      return true;
    }
    if (state.eat(
      98
      /* b */
    )) {
      state.lastIntValue = 8;
      return true;
    }
    state.pos = start;
    return false;
  }
  var ch = state.current();
  if (ch < 0 || ch === state.lookahead() && isClassSetReservedDoublePunctuatorCharacter(ch)) {
    return false;
  }
  if (isClassSetSyntaxCharacter(ch)) {
    return false;
  }
  state.advance();
  state.lastIntValue = ch;
  return true;
};
function isClassSetReservedDoublePunctuatorCharacter(ch) {
  return ch === 33 || ch >= 35 && ch <= 38 || ch >= 42 && ch <= 44 || ch === 46 || ch >= 58 && ch <= 64 || ch === 94 || ch === 96 || ch === 126;
}
function isClassSetSyntaxCharacter(ch) {
  return ch === 40 || ch === 41 || ch === 45 || ch === 47 || ch >= 91 && ch <= 93 || ch >= 123 && ch <= 125;
}
pp$1.regexp_eatClassSetReservedPunctuator = function(state) {
  var ch = state.current();
  if (isClassSetReservedPunctuator(ch)) {
    state.lastIntValue = ch;
    state.advance();
    return true;
  }
  return false;
};
function isClassSetReservedPunctuator(ch) {
  return ch === 33 || ch === 35 || ch === 37 || ch === 38 || ch === 44 || ch === 45 || ch >= 58 && ch <= 62 || ch === 64 || ch === 96 || ch === 126;
}
pp$1.regexp_eatClassControlLetter = function(state) {
  var ch = state.current();
  if (isDecimalDigit(ch) || ch === 95) {
    state.lastIntValue = ch % 32;
    state.advance();
    return true;
  }
  return false;
};
pp$1.regexp_eatHexEscapeSequence = function(state) {
  var start = state.pos;
  if (state.eat(
    120
    /* x */
  )) {
    if (this.regexp_eatFixedHexDigits(state, 2)) {
      return true;
    }
    if (state.switchU) {
      state.raise("Invalid escape");
    }
    state.pos = start;
  }
  return false;
};
pp$1.regexp_eatDecimalDigits = function(state) {
  var start = state.pos;
  var ch = 0;
  state.lastIntValue = 0;
  while (isDecimalDigit(ch = state.current())) {
    state.lastIntValue = 10 * state.lastIntValue + (ch - 48);
    state.advance();
  }
  return state.pos !== start;
};
function isDecimalDigit(ch) {
  return ch >= 48 && ch <= 57;
}
pp$1.regexp_eatHexDigits = function(state) {
  var start = state.pos;
  var ch = 0;
  state.lastIntValue = 0;
  while (isHexDigit(ch = state.current())) {
    state.lastIntValue = 16 * state.lastIntValue + hexToInt(ch);
    state.advance();
  }
  return state.pos !== start;
};
function isHexDigit(ch) {
  return ch >= 48 && ch <= 57 || ch >= 65 && ch <= 70 || ch >= 97 && ch <= 102;
}
function hexToInt(ch) {
  if (ch >= 65 && ch <= 70) {
    return 10 + (ch - 65);
  }
  if (ch >= 97 && ch <= 102) {
    return 10 + (ch - 97);
  }
  return ch - 48;
}
pp$1.regexp_eatLegacyOctalEscapeSequence = function(state) {
  if (this.regexp_eatOctalDigit(state)) {
    var n1 = state.lastIntValue;
    if (this.regexp_eatOctalDigit(state)) {
      var n2 = state.lastIntValue;
      if (n1 <= 3 && this.regexp_eatOctalDigit(state)) {
        state.lastIntValue = n1 * 64 + n2 * 8 + state.lastIntValue;
      } else {
        state.lastIntValue = n1 * 8 + n2;
      }
    } else {
      state.lastIntValue = n1;
    }
    return true;
  }
  return false;
};
pp$1.regexp_eatOctalDigit = function(state) {
  var ch = state.current();
  if (isOctalDigit(ch)) {
    state.lastIntValue = ch - 48;
    state.advance();
    return true;
  }
  state.lastIntValue = 0;
  return false;
};
function isOctalDigit(ch) {
  return ch >= 48 && ch <= 55;
}
pp$1.regexp_eatFixedHexDigits = function(state, length) {
  var start = state.pos;
  state.lastIntValue = 0;
  for (var i = 0; i < length; ++i) {
    var ch = state.current();
    if (!isHexDigit(ch)) {
      state.pos = start;
      return false;
    }
    state.lastIntValue = 16 * state.lastIntValue + hexToInt(ch);
    state.advance();
  }
  return true;
};
var Token = function Token2(p) {
  this.type = p.type;
  this.value = p.value;
  this.start = p.start;
  this.end = p.end;
  if (p.options.locations) {
    this.loc = new SourceLocation(p, p.startLoc, p.endLoc);
  }
  if (p.options.ranges) {
    this.range = [p.start, p.end];
  }
};
var pp = Parser.prototype;
pp.next = function(ignoreEscapeSequenceInKeyword) {
  if (!ignoreEscapeSequenceInKeyword && this.type.keyword && this.containsEsc) {
    this.raiseRecoverable(this.start, "Escape sequence in keyword " + this.type.keyword);
  }
  if (this.options.onToken) {
    this.options.onToken(new Token(this));
  }
  this.lastTokEnd = this.end;
  this.lastTokStart = this.start;
  this.lastTokEndLoc = this.endLoc;
  this.lastTokStartLoc = this.startLoc;
  this.nextToken();
};
pp.getToken = function() {
  this.next();
  return new Token(this);
};
if (typeof Symbol !== "undefined") {
  pp[Symbol.iterator] = function() {
    var this$1$1 = this;
    return {
      next: function() {
        var token = this$1$1.getToken();
        return {
          done: token.type === types$1.eof,
          value: token
        };
      }
    };
  };
}
pp.nextToken = function() {
  var curContext = this.curContext();
  if (!curContext || !curContext.preserveSpace) {
    this.skipSpace();
  }
  this.start = this.pos;
  if (this.options.locations) {
    this.startLoc = this.curPosition();
  }
  if (this.pos >= this.input.length) {
    return this.finishToken(types$1.eof);
  }
  if (curContext.override) {
    return curContext.override(this);
  } else {
    this.readToken(this.fullCharCodeAtPos());
  }
};
pp.readToken = function(code) {
  if (isIdentifierStart(code, this.options.ecmaVersion >= 6) || code === 92) {
    return this.readWord();
  }
  return this.getTokenFromCode(code);
};
pp.fullCharCodeAt = function(pos) {
  var code = this.input.charCodeAt(pos);
  if (code <= 55295 || code >= 56320) {
    return code;
  }
  var next = this.input.charCodeAt(pos + 1);
  return next <= 56319 || next >= 57344 ? code : (code << 10) + next - 56613888;
};
pp.fullCharCodeAtPos = function() {
  return this.fullCharCodeAt(this.pos);
};
pp.skipBlockComment = function() {
  var startLoc = this.options.onComment && this.curPosition();
  var start = this.pos, end = this.input.indexOf("*/", this.pos += 2);
  if (end === -1) {
    this.raise(this.pos - 2, "Unterminated comment");
  }
  this.pos = end + 2;
  if (this.options.locations) {
    for (var nextBreak = void 0, pos = start; (nextBreak = nextLineBreak(this.input, pos, this.pos)) > -1; ) {
      ++this.curLine;
      pos = this.lineStart = nextBreak;
    }
  }
  if (this.options.onComment) {
    this.options.onComment(
      true,
      this.input.slice(start + 2, end),
      start,
      this.pos,
      startLoc,
      this.curPosition()
    );
  }
};
pp.skipLineComment = function(startSkip) {
  var start = this.pos;
  var startLoc = this.options.onComment && this.curPosition();
  var ch = this.input.charCodeAt(this.pos += startSkip);
  while (this.pos < this.input.length && !isNewLine(ch)) {
    ch = this.input.charCodeAt(++this.pos);
  }
  if (this.options.onComment) {
    this.options.onComment(
      false,
      this.input.slice(start + startSkip, this.pos),
      start,
      this.pos,
      startLoc,
      this.curPosition()
    );
  }
};
pp.skipSpace = function() {
  loop: while (this.pos < this.input.length) {
    var ch = this.input.charCodeAt(this.pos);
    switch (ch) {
      case 32:
      case 160:
        ++this.pos;
        break;
      case 13:
        if (this.input.charCodeAt(this.pos + 1) === 10) {
          ++this.pos;
        }
      case 10:
      case 8232:
      case 8233:
        ++this.pos;
        if (this.options.locations) {
          ++this.curLine;
          this.lineStart = this.pos;
        }
        break;
      case 47:
        switch (this.input.charCodeAt(this.pos + 1)) {
          case 42:
            this.skipBlockComment();
            break;
          case 47:
            this.skipLineComment(2);
            break;
          default:
            break loop;
        }
        break;
      default:
        if (ch > 8 && ch < 14 || ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
          ++this.pos;
        } else {
          break loop;
        }
    }
  }
};
pp.finishToken = function(type, val) {
  this.end = this.pos;
  if (this.options.locations) {
    this.endLoc = this.curPosition();
  }
  var prevType = this.type;
  this.type = type;
  this.value = val;
  this.updateContext(prevType);
};
pp.readToken_dot = function() {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next >= 48 && next <= 57) {
    return this.readNumber(true);
  }
  var next2 = this.input.charCodeAt(this.pos + 2);
  if (this.options.ecmaVersion >= 6 && next === 46 && next2 === 46) {
    this.pos += 3;
    return this.finishToken(types$1.ellipsis);
  } else {
    ++this.pos;
    return this.finishToken(types$1.dot);
  }
};
pp.readToken_slash = function() {
  var next = this.input.charCodeAt(this.pos + 1);
  if (this.exprAllowed) {
    ++this.pos;
    return this.readRegexp();
  }
  if (next === 61) {
    return this.finishOp(types$1.assign, 2);
  }
  return this.finishOp(types$1.slash, 1);
};
pp.readToken_mult_modulo_exp = function(code) {
  var next = this.input.charCodeAt(this.pos + 1);
  var size = 1;
  var tokentype = code === 42 ? types$1.star : types$1.modulo;
  if (this.options.ecmaVersion >= 7 && code === 42 && next === 42) {
    ++size;
    tokentype = types$1.starstar;
    next = this.input.charCodeAt(this.pos + 2);
  }
  if (next === 61) {
    return this.finishOp(types$1.assign, size + 1);
  }
  return this.finishOp(tokentype, size);
};
pp.readToken_pipe_amp = function(code) {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === code) {
    if (this.options.ecmaVersion >= 12) {
      var next2 = this.input.charCodeAt(this.pos + 2);
      if (next2 === 61) {
        return this.finishOp(types$1.assign, 3);
      }
    }
    return this.finishOp(code === 124 ? types$1.logicalOR : types$1.logicalAND, 2);
  }
  if (next === 61) {
    return this.finishOp(types$1.assign, 2);
  }
  return this.finishOp(code === 124 ? types$1.bitwiseOR : types$1.bitwiseAND, 1);
};
pp.readToken_caret = function() {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) {
    return this.finishOp(types$1.assign, 2);
  }
  return this.finishOp(types$1.bitwiseXOR, 1);
};
pp.readToken_plus_min = function(code) {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === code) {
    if (next === 45 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 62 && (this.lastTokEnd === 0 || lineBreak.test(this.input.slice(this.lastTokEnd, this.pos)))) {
      this.skipLineComment(3);
      this.skipSpace();
      return this.nextToken();
    }
    return this.finishOp(types$1.incDec, 2);
  }
  if (next === 61) {
    return this.finishOp(types$1.assign, 2);
  }
  return this.finishOp(types$1.plusMin, 1);
};
pp.readToken_lt_gt = function(code) {
  var next = this.input.charCodeAt(this.pos + 1);
  var size = 1;
  if (next === code) {
    size = code === 62 && this.input.charCodeAt(this.pos + 2) === 62 ? 3 : 2;
    if (this.input.charCodeAt(this.pos + size) === 61) {
      return this.finishOp(types$1.assign, size + 1);
    }
    return this.finishOp(types$1.bitShift, size);
  }
  if (next === 33 && code === 60 && !this.inModule && this.input.charCodeAt(this.pos + 2) === 45 && this.input.charCodeAt(this.pos + 3) === 45) {
    this.skipLineComment(4);
    this.skipSpace();
    return this.nextToken();
  }
  if (next === 61) {
    size = 2;
  }
  return this.finishOp(types$1.relational, size);
};
pp.readToken_eq_excl = function(code) {
  var next = this.input.charCodeAt(this.pos + 1);
  if (next === 61) {
    return this.finishOp(types$1.equality, this.input.charCodeAt(this.pos + 2) === 61 ? 3 : 2);
  }
  if (code === 61 && next === 62 && this.options.ecmaVersion >= 6) {
    this.pos += 2;
    return this.finishToken(types$1.arrow);
  }
  return this.finishOp(code === 61 ? types$1.eq : types$1.prefix, 1);
};
pp.readToken_question = function() {
  var ecmaVersion = this.options.ecmaVersion;
  if (ecmaVersion >= 11) {
    var next = this.input.charCodeAt(this.pos + 1);
    if (next === 46) {
      var next2 = this.input.charCodeAt(this.pos + 2);
      if (next2 < 48 || next2 > 57) {
        return this.finishOp(types$1.questionDot, 2);
      }
    }
    if (next === 63) {
      if (ecmaVersion >= 12) {
        var next2$1 = this.input.charCodeAt(this.pos + 2);
        if (next2$1 === 61) {
          return this.finishOp(types$1.assign, 3);
        }
      }
      return this.finishOp(types$1.coalesce, 2);
    }
  }
  return this.finishOp(types$1.question, 1);
};
pp.readToken_numberSign = function() {
  var ecmaVersion = this.options.ecmaVersion;
  var code = 35;
  if (ecmaVersion >= 13) {
    ++this.pos;
    code = this.fullCharCodeAtPos();
    if (isIdentifierStart(code, true) || code === 92) {
      return this.finishToken(types$1.privateId, this.readWord1());
    }
  }
  this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
};
pp.getTokenFromCode = function(code) {
  switch (code) {
    // The interpretation of a dot depends on whether it is followed
    // by a digit or another two dots.
    case 46:
      return this.readToken_dot();
    // Punctuation tokens.
    case 40:
      ++this.pos;
      return this.finishToken(types$1.parenL);
    case 41:
      ++this.pos;
      return this.finishToken(types$1.parenR);
    case 59:
      ++this.pos;
      return this.finishToken(types$1.semi);
    case 44:
      ++this.pos;
      return this.finishToken(types$1.comma);
    case 91:
      ++this.pos;
      return this.finishToken(types$1.bracketL);
    case 93:
      ++this.pos;
      return this.finishToken(types$1.bracketR);
    case 123:
      ++this.pos;
      return this.finishToken(types$1.braceL);
    case 125:
      ++this.pos;
      return this.finishToken(types$1.braceR);
    case 58:
      ++this.pos;
      return this.finishToken(types$1.colon);
    case 96:
      if (this.options.ecmaVersion < 6) {
        break;
      }
      ++this.pos;
      return this.finishToken(types$1.backQuote);
    case 48:
      var next = this.input.charCodeAt(this.pos + 1);
      if (next === 120 || next === 88) {
        return this.readRadixNumber(16);
      }
      if (this.options.ecmaVersion >= 6) {
        if (next === 111 || next === 79) {
          return this.readRadixNumber(8);
        }
        if (next === 98 || next === 66) {
          return this.readRadixNumber(2);
        }
      }
    // Anything else beginning with a digit is an integer, octal
    // number, or float.
    case 49:
    case 50:
    case 51:
    case 52:
    case 53:
    case 54:
    case 55:
    case 56:
    case 57:
      return this.readNumber(false);
    // Quotes produce strings.
    case 34:
    case 39:
      return this.readString(code);
    // Operators are parsed inline in tiny state machines. '=' (61) is
    // often referred to. `finishOp` simply skips the amount of
    // characters it is given as second argument, and returns a token
    // of the type given by its first argument.
    case 47:
      return this.readToken_slash();
    case 37:
    case 42:
      return this.readToken_mult_modulo_exp(code);
    case 124:
    case 38:
      return this.readToken_pipe_amp(code);
    case 94:
      return this.readToken_caret();
    case 43:
    case 45:
      return this.readToken_plus_min(code);
    case 60:
    case 62:
      return this.readToken_lt_gt(code);
    case 61:
    case 33:
      return this.readToken_eq_excl(code);
    case 63:
      return this.readToken_question();
    case 126:
      return this.finishOp(types$1.prefix, 1);
    case 35:
      return this.readToken_numberSign();
  }
  this.raise(this.pos, "Unexpected character '" + codePointToString(code) + "'");
};
pp.finishOp = function(type, size) {
  var str = this.input.slice(this.pos, this.pos + size);
  this.pos += size;
  return this.finishToken(type, str);
};
pp.readRegexp = function() {
  var escaped, inClass, start = this.pos;
  for (; ; ) {
    if (this.pos >= this.input.length) {
      this.raise(start, "Unterminated regular expression");
    }
    var ch = this.input.charAt(this.pos);
    if (lineBreak.test(ch)) {
      this.raise(start, "Unterminated regular expression");
    }
    if (!escaped) {
      if (ch === "[") {
        inClass = true;
      } else if (ch === "]" && inClass) {
        inClass = false;
      } else if (ch === "/" && !inClass) {
        break;
      }
      escaped = ch === "\\";
    } else {
      escaped = false;
    }
    ++this.pos;
  }
  var pattern = this.input.slice(start, this.pos);
  ++this.pos;
  var flagsStart = this.pos;
  var flags = this.readWord1();
  if (this.containsEsc) {
    this.unexpected(flagsStart);
  }
  var state = this.regexpState || (this.regexpState = new RegExpValidationState(this));
  state.reset(start, pattern, flags);
  this.validateRegExpFlags(state);
  this.validateRegExpPattern(state);
  var value = null;
  try {
    value = new RegExp(pattern, flags);
  } catch (e) {
  }
  return this.finishToken(types$1.regexp, { pattern, flags, value });
};
pp.readInt = function(radix, len, maybeLegacyOctalNumericLiteral) {
  var allowSeparators = this.options.ecmaVersion >= 12 && len === void 0;
  var isLegacyOctalNumericLiteral = maybeLegacyOctalNumericLiteral && this.input.charCodeAt(this.pos) === 48;
  var start = this.pos, total = 0, lastCode = 0;
  for (var i = 0, e = len == null ? Infinity : len; i < e; ++i, ++this.pos) {
    var code = this.input.charCodeAt(this.pos), val = void 0;
    if (allowSeparators && code === 95) {
      if (isLegacyOctalNumericLiteral) {
        this.raiseRecoverable(this.pos, "Numeric separator is not allowed in legacy octal numeric literals");
      }
      if (lastCode === 95) {
        this.raiseRecoverable(this.pos, "Numeric separator must be exactly one underscore");
      }
      if (i === 0) {
        this.raiseRecoverable(this.pos, "Numeric separator is not allowed at the first of digits");
      }
      lastCode = code;
      continue;
    }
    if (code >= 97) {
      val = code - 97 + 10;
    } else if (code >= 65) {
      val = code - 65 + 10;
    } else if (code >= 48 && code <= 57) {
      val = code - 48;
    } else {
      val = Infinity;
    }
    if (val >= radix) {
      break;
    }
    lastCode = code;
    total = total * radix + val;
  }
  if (allowSeparators && lastCode === 95) {
    this.raiseRecoverable(this.pos - 1, "Numeric separator is not allowed at the last of digits");
  }
  if (this.pos === start || len != null && this.pos - start !== len) {
    return null;
  }
  return total;
};
function stringToNumber(str, isLegacyOctalNumericLiteral) {
  if (isLegacyOctalNumericLiteral) {
    return parseInt(str, 8);
  }
  return parseFloat(str.replace(/_/g, ""));
}
function stringToBigInt(str) {
  if (typeof BigInt !== "function") {
    return null;
  }
  return BigInt(str.replace(/_/g, ""));
}
pp.readRadixNumber = function(radix) {
  var start = this.pos;
  this.pos += 2;
  var val = this.readInt(radix);
  if (val == null) {
    this.raise(this.start + 2, "Expected number in radix " + radix);
  }
  if (this.options.ecmaVersion >= 11 && this.input.charCodeAt(this.pos) === 110) {
    val = stringToBigInt(this.input.slice(start, this.pos));
    ++this.pos;
  } else if (isIdentifierStart(this.fullCharCodeAtPos())) {
    this.raise(this.pos, "Identifier directly after number");
  }
  return this.finishToken(types$1.num, val);
};
pp.readNumber = function(startsWithDot) {
  var start = this.pos;
  if (!startsWithDot && this.readInt(10, void 0, true) === null) {
    this.raise(start, "Invalid number");
  }
  var octal = this.pos - start >= 2 && this.input.charCodeAt(start) === 48;
  if (octal && this.strict) {
    this.raise(start, "Invalid number");
  }
  var next = this.input.charCodeAt(this.pos);
  if (!octal && !startsWithDot && this.options.ecmaVersion >= 11 && next === 110) {
    var val$1 = stringToBigInt(this.input.slice(start, this.pos));
    ++this.pos;
    if (isIdentifierStart(this.fullCharCodeAtPos())) {
      this.raise(this.pos, "Identifier directly after number");
    }
    return this.finishToken(types$1.num, val$1);
  }
  if (octal && /[89]/.test(this.input.slice(start, this.pos))) {
    octal = false;
  }
  if (next === 46 && !octal) {
    ++this.pos;
    this.readInt(10);
    next = this.input.charCodeAt(this.pos);
  }
  if ((next === 69 || next === 101) && !octal) {
    next = this.input.charCodeAt(++this.pos);
    if (next === 43 || next === 45) {
      ++this.pos;
    }
    if (this.readInt(10) === null) {
      this.raise(start, "Invalid number");
    }
  }
  if (isIdentifierStart(this.fullCharCodeAtPos())) {
    this.raise(this.pos, "Identifier directly after number");
  }
  var val = stringToNumber(this.input.slice(start, this.pos), octal);
  return this.finishToken(types$1.num, val);
};
pp.readCodePoint = function() {
  var ch = this.input.charCodeAt(this.pos), code;
  if (ch === 123) {
    if (this.options.ecmaVersion < 6) {
      this.unexpected();
    }
    var codePos = ++this.pos;
    code = this.readHexChar(this.input.indexOf("}", this.pos) - this.pos);
    ++this.pos;
    if (code > 1114111) {
      this.invalidStringToken(codePos, "Code point out of bounds");
    }
  } else {
    code = this.readHexChar(4);
  }
  return code;
};
pp.readString = function(quote) {
  var out = "", chunkStart = ++this.pos;
  for (; ; ) {
    if (this.pos >= this.input.length) {
      this.raise(this.start, "Unterminated string constant");
    }
    var ch = this.input.charCodeAt(this.pos);
    if (ch === quote) {
      break;
    }
    if (ch === 92) {
      out += this.input.slice(chunkStart, this.pos);
      out += this.readEscapedChar(false);
      chunkStart = this.pos;
    } else if (ch === 8232 || ch === 8233) {
      if (this.options.ecmaVersion < 10) {
        this.raise(this.start, "Unterminated string constant");
      }
      ++this.pos;
      if (this.options.locations) {
        this.curLine++;
        this.lineStart = this.pos;
      }
    } else {
      if (isNewLine(ch)) {
        this.raise(this.start, "Unterminated string constant");
      }
      ++this.pos;
    }
  }
  out += this.input.slice(chunkStart, this.pos++);
  return this.finishToken(types$1.string, out);
};
var INVALID_TEMPLATE_ESCAPE_ERROR = {};
pp.tryReadTemplateToken = function() {
  this.inTemplateElement = true;
  try {
    this.readTmplToken();
  } catch (err) {
    if (err === INVALID_TEMPLATE_ESCAPE_ERROR) {
      this.readInvalidTemplateToken();
    } else {
      throw err;
    }
  }
  this.inTemplateElement = false;
};
pp.invalidStringToken = function(position3, message) {
  if (this.inTemplateElement && this.options.ecmaVersion >= 9) {
    throw INVALID_TEMPLATE_ESCAPE_ERROR;
  } else {
    this.raise(position3, message);
  }
};
pp.readTmplToken = function() {
  var out = "", chunkStart = this.pos;
  for (; ; ) {
    if (this.pos >= this.input.length) {
      this.raise(this.start, "Unterminated template");
    }
    var ch = this.input.charCodeAt(this.pos);
    if (ch === 96 || ch === 36 && this.input.charCodeAt(this.pos + 1) === 123) {
      if (this.pos === this.start && (this.type === types$1.template || this.type === types$1.invalidTemplate)) {
        if (ch === 36) {
          this.pos += 2;
          return this.finishToken(types$1.dollarBraceL);
        } else {
          ++this.pos;
          return this.finishToken(types$1.backQuote);
        }
      }
      out += this.input.slice(chunkStart, this.pos);
      return this.finishToken(types$1.template, out);
    }
    if (ch === 92) {
      out += this.input.slice(chunkStart, this.pos);
      out += this.readEscapedChar(true);
      chunkStart = this.pos;
    } else if (isNewLine(ch)) {
      out += this.input.slice(chunkStart, this.pos);
      ++this.pos;
      switch (ch) {
        case 13:
          if (this.input.charCodeAt(this.pos) === 10) {
            ++this.pos;
          }
        case 10:
          out += "\n";
          break;
        default:
          out += String.fromCharCode(ch);
          break;
      }
      if (this.options.locations) {
        ++this.curLine;
        this.lineStart = this.pos;
      }
      chunkStart = this.pos;
    } else {
      ++this.pos;
    }
  }
};
pp.readInvalidTemplateToken = function() {
  for (; this.pos < this.input.length; this.pos++) {
    switch (this.input[this.pos]) {
      case "\\":
        ++this.pos;
        break;
      case "$":
        if (this.input[this.pos + 1] !== "{") {
          break;
        }
      // fall through
      case "`":
        return this.finishToken(types$1.invalidTemplate, this.input.slice(this.start, this.pos));
      case "\r":
        if (this.input[this.pos + 1] === "\n") {
          ++this.pos;
        }
      // fall through
      case "\n":
      case "\u2028":
      case "\u2029":
        ++this.curLine;
        this.lineStart = this.pos + 1;
        break;
    }
  }
  this.raise(this.start, "Unterminated template");
};
pp.readEscapedChar = function(inTemplate) {
  var ch = this.input.charCodeAt(++this.pos);
  ++this.pos;
  switch (ch) {
    case 110:
      return "\n";
    // 'n' -> '\n'
    case 114:
      return "\r";
    // 'r' -> '\r'
    case 120:
      return String.fromCharCode(this.readHexChar(2));
    // 'x'
    case 117:
      return codePointToString(this.readCodePoint());
    // 'u'
    case 116:
      return "	";
    // 't' -> '\t'
    case 98:
      return "\b";
    // 'b' -> '\b'
    case 118:
      return "\v";
    // 'v' -> '\u000b'
    case 102:
      return "\f";
    // 'f' -> '\f'
    case 13:
      if (this.input.charCodeAt(this.pos) === 10) {
        ++this.pos;
      }
    // '\r\n'
    case 10:
      if (this.options.locations) {
        this.lineStart = this.pos;
        ++this.curLine;
      }
      return "";
    case 56:
    case 57:
      if (this.strict) {
        this.invalidStringToken(
          this.pos - 1,
          "Invalid escape sequence"
        );
      }
      if (inTemplate) {
        var codePos = this.pos - 1;
        this.invalidStringToken(
          codePos,
          "Invalid escape sequence in template string"
        );
      }
    default:
      if (ch >= 48 && ch <= 55) {
        var octalStr = this.input.substr(this.pos - 1, 3).match(/^[0-7]+/)[0];
        var octal = parseInt(octalStr, 8);
        if (octal > 255) {
          octalStr = octalStr.slice(0, -1);
          octal = parseInt(octalStr, 8);
        }
        this.pos += octalStr.length - 1;
        ch = this.input.charCodeAt(this.pos);
        if ((octalStr !== "0" || ch === 56 || ch === 57) && (this.strict || inTemplate)) {
          this.invalidStringToken(
            this.pos - 1 - octalStr.length,
            inTemplate ? "Octal literal in template string" : "Octal literal in strict mode"
          );
        }
        return String.fromCharCode(octal);
      }
      if (isNewLine(ch)) {
        if (this.options.locations) {
          this.lineStart = this.pos;
          ++this.curLine;
        }
        return "";
      }
      return String.fromCharCode(ch);
  }
};
pp.readHexChar = function(len) {
  var codePos = this.pos;
  var n = this.readInt(16, len);
  if (n === null) {
    this.invalidStringToken(codePos, "Bad character escape sequence");
  }
  return n;
};
pp.readWord1 = function() {
  this.containsEsc = false;
  var word = "", first = true, chunkStart = this.pos;
  var astral = this.options.ecmaVersion >= 6;
  while (this.pos < this.input.length) {
    var ch = this.fullCharCodeAtPos();
    if (isIdentifierChar(ch, astral)) {
      this.pos += ch <= 65535 ? 1 : 2;
    } else if (ch === 92) {
      this.containsEsc = true;
      word += this.input.slice(chunkStart, this.pos);
      var escStart = this.pos;
      if (this.input.charCodeAt(++this.pos) !== 117) {
        this.invalidStringToken(this.pos, "Expecting Unicode escape sequence \\uXXXX");
      }
      ++this.pos;
      var esc = this.readCodePoint();
      if (!(first ? isIdentifierStart : isIdentifierChar)(esc, astral)) {
        this.invalidStringToken(escStart, "Invalid Unicode escape");
      }
      word += codePointToString(esc);
      chunkStart = this.pos;
    } else {
      break;
    }
    first = false;
  }
  return word + this.input.slice(chunkStart, this.pos);
};
pp.readWord = function() {
  var word = this.readWord1();
  var type = types$1.name;
  if (this.keywords.test(word)) {
    type = keywords[word];
  }
  return this.finishToken(type, word);
};
var version = "8.16.0";
Parser.acorn = {
  Parser,
  version,
  defaultOptions,
  Position,
  SourceLocation,
  getLineInfo,
  Node,
  TokenType,
  tokTypes: types$1,
  keywordTypes: keywords,
  TokContext,
  tokContexts: types,
  isIdentifierChar,
  isIdentifierStart,
  Token,
  isNewLine,
  lineBreak,
  lineBreakG,
  nonASCIIwhitespace
};
function parse3(input, options) {
  return Parser.parse(input, options);
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/spec/host-parameters.js
function isHostStructFieldName(name2) {
  return name2.length > 0 && name2 !== "__proto__" && name2 !== "prototype" && name2 !== "constructor";
}
function hostOperationArity(operation) {
  const firstOmittable = operation.parameters.findIndex((parameter) => parameter.type === "omittable");
  return {
    min: firstOmittable < 0 ? operation.parameters.length : firstOmittable,
    max: operation.parameters.length
  };
}
function acceptsHostArgumentCount(operation, count) {
  const { min, max } = hostOperationArity(operation);
  return Number.isInteger(count) && count >= min && count <= max;
}
function hostParameterValueSpec(parameter) {
  return parameter.type === "omittable" ? parameter.spec : parameter;
}
function cloneParameterSpec(spec2) {
  switch (spec2.type) {
    case "omittable":
      return { type: "omittable", spec: cloneParameterSpec(spec2.spec) };
    case "enum":
      return { type: "enum", values: [...spec2.values] };
    case "array":
      return { type: "array", element: cloneParameterSpec(spec2.element) };
    case "tuple":
      return {
        type: "tuple",
        elements: spec2.elements.map((element) => cloneParameterSpec(element))
      };
    case "struct":
      return {
        type: "struct",
        fields: Object.fromEntries(Object.entries(spec2.fields).map(([name2, field]) => [
          name2,
          cloneParameterSpec(field)
        ]))
      };
    default:
      return { type: spec2.type };
  }
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/types/spec.js
function isObservableCellSpec(spec2) {
  return spec2.type !== "dialogCursor" && spec2.type !== "artifact" && (spec2.type !== "array" || spec2.element.type !== "artifact");
}
function isSettableCellSpec(spec2) {
  return isObservableCellSpec(spec2) || spec2.type === "array" || spec2.type === "dialogCursor" || spec2.type === "artifact";
}
function cellSpecToChannelSpec(spec2) {
  switch (spec2.type) {
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "enum", values: spec2.values };
    case "number":
      return { type: "number" };
    case "dialogCursor":
      return { type: "dialogCursor" };
    case "artifact":
      return { type: "artifact" };
    case "array":
      return {
        type: "array",
        element: arrayElementSpecToChannelSpec(spec2.element)
      };
  }
}
function arrayElementSpecToChannelSpec(spec2) {
  switch (spec2.type) {
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "enum":
      return { type: "enum", values: spec2.values };
    case "number":
      return { type: "number" };
    case "artifact":
      return { type: "artifact" };
  }
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/types/value.js
function isPrimitiveValue(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function isPrimitiveArrayValue(value) {
  return Array.isArray(value) && value.every(isPrimitiveValue);
}
function isDialogCursorValue(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || key !== "user" && key !== "self" && key !== "view") || !keys.includes("user") || !keys.includes("self")) {
      return false;
    }
    const fields = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]));
    const user = fields.user;
    const self = fields.self;
    const view = fields.view;
    if (!user || !self || !("value" in user) || !("value" in self) || !user.enumerable || !self.enumerable || view && (!("value" in view) || !view.enumerable)) {
      return false;
    }
    return Number.isSafeInteger(user.value) && Number.isSafeInteger(self.value) && user.value >= 0 && self.value >= 0 && (!view || view.value === void 0 || typeof view.value === "string");
  } catch {
    return false;
  }
}
function classifyArtifactPath(path) {
  if (typeof path !== "string")
    return "non-string";
  if (path.length === 0)
    return "empty";
  if (path.startsWith("/"))
    return "absolute";
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return "dot-segment";
  }
  return void 0;
}
function classifyArtifactValue(value) {
  try {
    return classifyArtifactValueShape(value);
  } catch {
    return "not-plain-object";
  }
}
function classifyArtifactValueShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "not-plain-object";
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return "not-plain-object";
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || !keys.includes("path"))
    return "invalid-keys";
  const path = Object.getOwnPropertyDescriptor(value, "path");
  if (!path || !("value" in path) || !path.enumerable) {
    return "invalid-properties";
  }
  return classifyArtifactPath(path.value);
}
function isArtifactValue(value) {
  return classifyArtifactValue(value) === void 0;
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/value-utils.js
function firstInvalidPayloadValue(value, path = "$") {
  try {
    return firstInvalidPayloadValueShape(value, path, true);
  } catch {
    return {
      path,
      code: "invalid-struct-value",
      detail: "payload value shape could not be inspected"
    };
  }
}
function firstInvalidPayloadValueShape(value, path, allowUndefined) {
  if (value === void 0) {
    return allowUndefined ? void 0 : {
      path,
      code: "invalid-struct-value",
      detail: "nested payload values cannot be undefined"
    };
  }
  if (value === null) {
    return {
      path,
      code: "invalid-struct-value",
      detail: "payload values cannot be null"
    };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return void 0;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return {
        path,
        code: "invalid-struct-value",
        detail: "payload arrays must use the ordinary Array prototype"
      };
    }
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return {
          path: `${path}[${index}]`,
          code: "invalid-struct-value",
          detail: "payload arrays must be dense enumerable data values"
        };
      }
      const issue2 = firstInvalidPayloadValueShape(descriptor.value, `${path}[${index}]`, false);
      if (issue2)
        return issue2;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length")
        continue;
      if (typeof key !== "string" || !Number.isSafeInteger(Number(key)) || Number(key) < 0 || String(Number(key)) !== key || Number(key) >= value.length) {
        return {
          path: typeof key === "string" ? `${path}[${JSON.stringify(key)}]` : path,
          code: "invalid-struct-value",
          detail: "payload arrays cannot contain non-element properties"
        };
      }
    }
    return void 0;
  }
  if (typeof value !== "object") {
    return {
      path,
      code: "invalid-struct-value",
      detail: `unsupported payload value type ${typeof value}`
    };
  }
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return {
      path,
      code: "invalid-struct-value",
      detail: "payload struct shape could not be inspected"
    };
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return {
      path,
      code: "invalid-struct-value",
      detail: "payload structs must be plain objects"
    };
  }
  for (const key of keys) {
    if (typeof key !== "string") {
      return {
        path,
        code: "invalid-struct-value",
        detail: "payload structs cannot contain symbol keys"
      };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return {
        path: `${path}[${JSON.stringify(key)}]`,
        code: "invalid-struct-value",
        detail: "payload struct fields must be enumerable data properties"
      };
    }
    const issue2 = firstInvalidPayloadValueShape(descriptor.value, `${path}[${JSON.stringify(key)}]`, false);
    if (issue2)
      return issue2;
  }
  return void 0;
}
function firstNonFiniteNumberPath(value, path = "$") {
  if (typeof value === "number") {
    return Number.isFinite(value) ? void 0 : path;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = firstNonFiniteNumberPath(value[index], `${path}[${index}]`);
      if (found)
        return found;
    }
    return void 0;
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const found = firstNonFiniteNumberPath(value[key], `${path}[${JSON.stringify(key)}]`);
      if (found)
        return found;
    }
  }
  return void 0;
}
function describeArtifactPathIssue(issue2) {
  switch (issue2) {
    case "non-string":
      return "path must be a string";
    case "empty":
      return "path cannot be empty";
    case "absolute":
      return "path must be relative";
    case "dot-segment":
      return 'path cannot contain "." or ".." segments';
  }
}
function describeArtifactValueIssue(issue2) {
  switch (issue2) {
    case "not-plain-object":
      return "value must be a plain object";
    case "invalid-keys":
      return "value must contain exactly path";
    case "invalid-properties":
      return "path must be an enumerable data property";
    default:
      return describeArtifactPathIssue(issue2);
  }
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/spec/resolution.js
function resolveHostOperation(modules, action) {
  let current2 = modules.get(action.module);
  if (!current2)
    return { kind: "unresolved", reason: "module" };
  for (const segment of [...action.target, action.operation]) {
    if (current2.kind !== "namespace") {
      return { kind: "unresolved", reason: "namespace", segment };
    }
    current2 = current2.members[segment];
    if (!current2) {
      return { kind: "unresolved", reason: "member", segment };
    }
  }
  return current2.kind === "operation" ? { kind: "resolved", operation: current2 } : { kind: "unresolved", reason: "namespace" };
}
function admitValue(spec2, value, path = "$") {
  if (value === void 0) {
    return violation("unset", "A set value is required", path);
  }
  switch (spec2.type) {
    case "boolean":
      return typeof value === "boolean" ? admitted(value) : violation("invalid-boolean", "A boolean value is required", path);
    case "string":
      return typeof value === "string" ? admitted(value) : violation("invalid-string", "A string value is required", path);
    case "enum":
      return typeof value === "string" && spec2.values.includes(value) ? admitted(value) : violation("invalid-enum", `Expected one of ${spec2.values.map((entry) => JSON.stringify(entry)).join(", ")}`, path);
    case "number":
      if (typeof value !== "number") {
        return violation("invalid-number", "A numeric value is required", path);
      }
      return Number.isFinite(value) ? admitted(value) : violation("non-finite-number", "A finite number is required", path);
    case "index":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? admitted(value) : violation("invalid-index", "A non-negative safe integer is required", path);
    case "array":
      if (!Array.isArray(value)) {
        return violation("invalid-array", "An array value is required", path);
      }
      for (const [index, element] of value.entries()) {
        const result = admitValue(spec2.element, element, `${path}[${index}]`);
        if (!result.admitted)
          return result;
      }
      return admitted(value);
    case "artifact": {
      const issue2 = classifyArtifactValue(value);
      return issue2 === void 0 ? admitted(value) : violation("invalid-artifact", `Invalid Artifact value: ${describeArtifactValueIssue(issue2)}`, path);
    }
    case "dialogCursor":
      return isDialogCursorValue(value) ? admitted(value) : violation("invalid-dialog-cursor", "A valid Dialog cursor is required", path);
  }
}
function admitted(value) {
  return { admitted: true, value };
}
function violation(code, detail, path) {
  return { admitted: false, violation: { code, detail, path } };
}
var COMPATIBLE = { kind: "compatible" };
var INCOMPATIBLE = { kind: "incompatible" };
var UNKNOWN = { kind: "unknown" };
function judgeOneTimeLanding(source, destination) {
  if (!source)
    return UNKNOWN;
  switch (source.kind) {
    case "site":
      return judgeSpecLanding(source.spec, destination);
    case "literal":
      return admitValue(destination, source.value).admitted ? COMPATIBLE : INCOMPATIBLE;
    case "carrier":
      switch (source.carrier) {
        case "boolean":
          return destination.type === "boolean" ? COMPATIBLE : INCOMPATIBLE;
        case "string":
          if (destination.type === "string")
            return COMPATIBLE;
          return destination.type === "enum" ? UNKNOWN : INCOMPATIBLE;
        case "number":
          return destination.type === "number" || destination.type === "index" ? UNKNOWN : INCOMPATIBLE;
      }
    case "provenance":
      if (source.provenance === "index") {
        return destination.type === "index" || destination.type === "number" ? COMPATIBLE : INCOMPATIBLE;
      }
      return source.provenance === "artifact" ? destination.type === "artifact" ? COMPATIBLE : INCOMPATIBLE : destination.type === "dialogCursor" ? COMPATIBLE : INCOMPATIBLE;
    case "array":
      if (destination.type !== "array")
        return INCOMPATIBLE;
      return reduceAlternativeJudgments(source.elements.map((element) => judgeOneTimeLanding(element, destination.element)));
    case "empty-array":
      return destination.type === "array" ? COMPATIBLE : INCOMPATIBLE;
  }
}
function reduceAlternativeJudgments(judgments) {
  if (judgments.some((judgment) => judgment.kind === "incompatible")) {
    return INCOMPATIBLE;
  }
  if (judgments.some((judgment) => judgment.kind === "unknown"))
    return UNKNOWN;
  return COMPATIBLE;
}
function reusableSpecCompatible(provider, receiver) {
  if (provider.type === "index" && receiver.type === "number")
    return true;
  if (provider.type === "enum" && receiver.type === "string")
    return true;
  if (provider.type !== receiver.type)
    return false;
  if (provider.type === "enum" && receiver.type === "enum") {
    return provider.values.every((value) => receiver.values.includes(value));
  }
  if (provider.type === "array" && receiver.type === "array") {
    return reusableSpecCompatible(provider.element, receiver.element);
  }
  return true;
}
function judgeSpecLanding(source, destination) {
  if (reusableSpecCompatible(source, destination))
    return COMPATIBLE;
  if (source.type === "number" && destination.type === "index")
    return UNKNOWN;
  if (source.type === "string" && destination.type === "enum")
    return UNKNOWN;
  if (source.type === "enum" && destination.type === "enum") {
    return source.values.some((value) => destination.values.includes(value)) ? UNKNOWN : INCOMPATIBLE;
  }
  if (source.type === "array" && destination.type === "array") {
    return judgeSpecLanding(source.element, destination.element);
  }
  return INCOMPATIBLE;
}
function resolveProducer(expression, context) {
  switch (expression.kind) {
    case "literal":
      return expression.value === null ? { kind: "unusable" } : { kind: "fact", fact: { kind: "literal", value: expression.value } };
    case "cell": {
      const cell = findCell(context, expression.name);
      return cell ? {
        kind: "fact",
        fact: { kind: "site", spec: cellSpecToChannelSpec(cell) }
      } : { kind: "dynamic" };
    }
    case "channel": {
      const spec2 = context.signature?.[expression.namespace][expression.key];
      return spec2 ? { kind: "fact", fact: { kind: "site", spec: spec2 } } : { kind: "dynamic" };
    }
    case "arrayElementRead": {
      const spec2 = resolveArrayElementSpec(expression.array, context);
      return spec2 ? { kind: "fact", fact: { kind: "site", spec: spec2 } } : { kind: "dynamic" };
    }
    case "span":
      if (expression.key === "index") {
        return {
          kind: "fact",
          fact: { kind: "provenance", provenance: "index" }
        };
      }
      return context.map?.receiverSpec ? {
        kind: "fact",
        fact: { kind: "site", spec: context.map.receiverSpec }
      } : { kind: "dynamic" };
    case "dialogCursor":
      return {
        kind: "fact",
        fact: { kind: "provenance", provenance: "dialog-cursor" }
      };
    case "artifact":
      return resolvedFact(artifactPathRule.result);
    case "arrayLength":
      return {
        kind: "fact",
        fact: { kind: "provenance", provenance: "index" }
      };
    case "template-string":
      return resolvedFact(interpolationRule.result);
    case "scope":
    case "interruptionId":
    case "interruptionReason":
    case "pendingState":
    case "nodeState":
      return resolvedFact(stringOperandRule.result);
    case "dialogTurnsSince":
    case "enterCount":
    case "arithmetic":
    case "numericUnary":
      return resolvedFact(arithmeticRule.result);
    case "comparison":
      return resolvedFact(comparisonRule.result);
    case "logical":
    case "unary":
    case "regexTest":
    case "isUnset":
    case "channelIsUnset":
    case "deflectionEscaped":
    case "judge":
      return resolvedFact(booleanRule.result);
    case "numIsFinite":
      return resolvedFact(numIsFiniteRule.result);
    case "conditional":
      return {
        kind: "alternatives",
        alternatives: [
          resolveProducer(expression.consequent, context),
          resolveProducer(expression.alternate, context)
        ]
      };
    case "arrayLiteral":
      return expression.elements.length === 0 ? { kind: "fact", fact: { kind: "empty-array" } } : {
        kind: "array",
        elements: expression.elements.map((element) => resolveProducer(element, context))
      };
    case "host-call": {
      const operation = context.resolveHostOperation?.(expression);
      if (!operation)
        return { kind: "dynamic" };
      return operation.returns ? { kind: "fact", fact: { kind: "site", spec: operation.returns } } : { kind: "unusable" };
    }
  }
}
function judgeHostArgument(argument, destination, context) {
  if (argument.kind === "object") {
    if (destination.type !== "struct")
      return INCOMPATIBLE;
    if (Object.keys(argument.value).some((name2) => !Object.hasOwn(destination.fields, name2)) || Object.entries(destination.fields).some(([name2, field]) => field.type !== "omittable" && !Object.hasOwn(argument.value, name2)))
      return INCOMPATIBLE;
    return reduceAlternativeJudgments(Object.entries(argument.value).map(([name2, value]) => judgeHostArgument(value, hostParameterValueSpec(destination.fields[name2]), context)));
  }
  if (argument.kind === "array") {
    if (destination.type === "tuple") {
      if (argument.elements.length !== destination.elements.length) {
        return { kind: "incompatible" };
      }
      return reduceAlternativeJudgments(argument.elements.map((element, index) => judgeHostArgument(element, destination.elements[index], context)));
    }
    if (destination.type !== "array")
      return { kind: "incompatible" };
    return reduceAlternativeJudgments(argument.elements.map((element) => judgeHostArgument(element, destination.element, context)));
  }
  if (argument.kind === "semantic") {
    if (destination.type === "semanticText")
      return { kind: "compatible" };
    if (destination.type !== "string" && destination.type !== "enum") {
      return { kind: "incompatible" };
    }
    return judgeSemanticArgument(argument.value, destination, context);
  }
  if (destination.type === "semanticText") {
    return stringOperandRule.checkProducer(argument.value, context);
  }
  const channelSpec = hostParameterChannelSpec(destination);
  return channelSpec ? judgeProducerLanding(resolveProducer(argument.value, context), channelSpec) : { kind: "incompatible" };
}
function judgeProducerLanding(evidence, destination) {
  switch (evidence.kind) {
    case "fact":
      return judgeOneTimeLanding(evidence.fact, destination);
    case "dynamic":
      return judgeOneTimeLanding(void 0, destination);
    case "unusable":
    case "struct":
      return { kind: "incompatible" };
    case "alternatives":
      return reduceAlternativeJudgments(evidence.alternatives.map((alternative) => judgeProducerLanding(alternative, destination)));
    case "array":
      if (destination.type !== "array")
        return { kind: "incompatible" };
      return reduceAlternativeJudgments(evidence.elements.map((element) => judgeProducerLanding(element, destination.element)));
  }
}
function producerGuaranteesArtifact(evidence) {
  switch (evidence.kind) {
    case "fact":
      return evidence.fact.kind === "provenance" && evidence.fact.provenance === "artifact" || evidence.fact.kind === "site" && evidence.fact.spec.type === "artifact";
    case "alternatives":
      return evidence.alternatives.length > 0 && evidence.alternatives.every(producerGuaranteesArtifact);
    default:
      return false;
  }
}
var numIsFiniteRule = {
  checkProducer(operand, context) {
    return judgeNumericEvidence(resolveProducer(operand, context));
  },
  admitValue(value) {
    return typeof value === "number" ? { admitted: true, value } : {
      admitted: false,
      violation: {
        code: "invalid-number",
        detail: "A numeric value is required",
        path: "$"
      }
    };
  },
  result: { kind: "carrier", carrier: "boolean" }
};
var arithmeticRule = {
  checkProducer(operand, context) {
    return judgeNumericEvidence(resolveProducer(operand, context));
  },
  admitValue: numIsFiniteRule.admitValue,
  result: { kind: "carrier", carrier: "number" }
};
var booleanRule = {
  checkProducer(operand, context) {
    return judgeBooleanEvidence(resolveProducer(operand, context));
  },
  admitValue(value) {
    return typeof value === "boolean" ? operationAdmitted(value) : operationViolation("non-boolean-value", "A boolean value is required");
  },
  result: { kind: "carrier", carrier: "boolean" }
};
var stringOperandRule = {
  checkProducer(operand, context) {
    return judgeStringEvidence(resolveProducer(operand, context));
  },
  admitValue(value) {
    return typeof value === "string" ? operationAdmitted(value) : operationViolation("invalid-string", "A string value is required");
  },
  result: { kind: "carrier", carrier: "string" }
};
var artifactPathRule = {
  checkProducer: stringOperandRule.checkProducer,
  admitValue(value) {
    if (typeof value !== "string") {
      return operationViolation("invalid-artifact-path", "Artifact path must be a string");
    }
    const issue2 = classifyArtifactPath(value);
    return issue2 === void 0 ? operationAdmitted(value) : operationViolation("invalid-artifact-path", `Artifact ${describeArtifactPathIssue(issue2)}`);
  },
  result: {
    kind: "provenance",
    provenance: "artifact"
  }
};
var interpolationRule = {
  checkProducer(operand, context) {
    return judgeInterpolationEvidence(resolveProducer(operand, context));
  },
  projectValue(evidence, value) {
    if (value === void 0) {
      return operationViolation("invalid-template-interpolation", "Value template interpolation cannot use an unset value");
    }
    if (producerGuaranteesArtifact(evidence)) {
      return isArtifactValue(value) ? operationAdmitted(value.path) : operationViolation("invalid-artifact-value", "Artifact interpolation requires a valid Artifact value");
    }
    if (isPrimitiveValue(value)) {
      if (typeof value === "number" && !Number.isFinite(value)) {
        return operationViolation("non-finite-number", "Numeric value must be finite before value-template interpolation");
      }
      return operationAdmitted(String(value));
    }
    if (isPrimitiveArrayValue(value)) {
      const nonFinitePath = firstNonFiniteNumberPath(value);
      if (nonFinitePath !== void 0) {
        return operationViolation("non-finite-number", `Numeric value must be finite before value-template interpolation${nonFinitePath === "$" ? "" : ` at ${nonFinitePath}`}`);
      }
      return operationAdmitted(String(value));
    }
    return operationViolation("invalid-template-interpolation", "Value template interpolation cannot render this value");
  },
  result: { kind: "carrier", carrier: "string" }
};
var comparisonRule = {
  checkProducers(op, left, right, context) {
    return decideComparison(op, resolveProducer(left, context), resolveProducer(right, context));
  },
  admitValues(op, decision2, left, right) {
    switch (decision2.mode) {
      case "enum": {
        const spec2 = {
          type: "enum",
          values: [...decision2.enumValues ?? []]
        };
        const admittedLeft = admitValue(spec2, left);
        const admittedRight = admitValue(spec2, right);
        if (!admittedLeft.admitted || !admittedRight.admitted) {
          return operationViolation("invalid-enum-value", "Enum comparison requires values in the selected Enum domain");
        }
        return operationAdmitted({ left, right });
      }
      case "number": {
        const admittedLeft = admitValue({ type: "number" }, left);
        const admittedRight = admitValue({ type: "number" }, right);
        if (!admittedLeft.admitted || !admittedRight.admitted) {
          const nonFinite = typeof left === "number" && !Number.isFinite(left) || typeof right === "number" && !Number.isFinite(right);
          return operationViolation(nonFinite ? "non-finite-number" : "invalid-numeric-comparison", nonFinite ? "Numeric value must be finite before numeric comparison" : "Numeric comparison requires finite numeric operands");
        }
        return operationAdmitted({ left, right });
      }
      case "string":
        return typeof left === "string" && typeof right === "string" ? operationAdmitted({ left, right }) : operationViolation("invalid-string-comparison", "String comparison requires string operands");
      case "boolean":
        return typeof left === "boolean" && typeof right === "boolean" ? operationAdmitted({ left, right }) : operationViolation("invalid-boolean-comparison", "Boolean equality requires boolean operands");
      case "artifact":
        return isArtifactValue(left) && isArtifactValue(right) ? operationAdmitted({ left, right }) : operationViolation("invalid-artifact-value", "Artifact equality requires valid Artifact values");
      case "array":
        return admitArrayComparisonValues(decision2.arrayElementFamily, left, right);
      case "dynamic":
        if (Array.isArray(left) || Array.isArray(right)) {
          return admitArrayComparisonValues(void 0, left, right);
        }
        if (typeof left === "number" || typeof right === "number") {
          const admittedLeft = admitValue({ type: "number" }, left);
          const admittedRight = admitValue({ type: "number" }, right);
          if (admittedLeft.admitted && admittedRight.admitted) {
            return operationAdmitted({ left, right });
          }
          const nonFinite = typeof left === "number" && !Number.isFinite(left) || typeof right === "number" && !Number.isFinite(right);
          return operationViolation(nonFinite ? "non-finite-number" : "invalid-numeric-comparison", nonFinite ? "Numeric value must be finite before numeric comparison" : "Numeric comparison requires finite numeric operands");
        }
        if (op !== "==" && op !== "!=") {
          return typeof left === "string" && typeof right === "string" ? operationAdmitted({ left, right }) : operationViolation("invalid-comparison-operands", "Ordering requires two finite numbers or two strings");
        }
        return operationAdmitted({ left, right });
    }
  },
  result: { kind: "carrier", carrier: "boolean" }
};
function decideComparison(op, left, right) {
  const ordering = op !== "==" && op !== "!=";
  const leftEnum = provenEnumDomain(left);
  const rightEnum = provenEnumDomain(right);
  if (ordering && (leftEnum || rightEnum)) {
    if (leftEnum && rightEnum && !sameEnumDomain(leftEnum, rightEnum)) {
      return decision("incompatible", "enum");
    }
    const enumValues = leftEnum ?? rightEnum;
    const judgment = reduceAlternativeJudgments([
      judgeEnumOperand(left, enumValues),
      judgeEnumOperand(right, enumValues)
    ]);
    return { judgment, mode: "enum", enumValues };
  }
  const leftFamily = stableFamily(left);
  const rightFamily = stableFamily(right);
  const known = leftFamily === "dynamic" ? rightFamily : leftFamily;
  if (known === "artifact") {
    if (leftFamily === "dynamic" || rightFamily === "dynamic") {
      return decision("unknown", "dynamic");
    }
    return leftFamily === "artifact" && rightFamily === "artifact" && !ordering ? decision("compatible", "artifact") : decision("incompatible", "artifact");
  }
  if (known === "array") {
    if (ordering)
      return decision("incompatible", "array");
    const elementFamilies = /* @__PURE__ */ new Set();
    collectArrayElementFamilies(left, elementFamilies);
    collectArrayElementFamilies(right, elementFamilies);
    if (elementFamilies.size > 1) {
      return decision("incompatible", "array");
    }
    const arrayElementFamily = elementFamilies.values().next().value;
    const judgment = reduceAlternativeJudgments([
      judgeArrayEvidence(left, arrayElementFamily),
      judgeArrayEvidence(right, arrayElementFamily)
    ]);
    return { judgment, mode: "array", arrayElementFamily };
  }
  if (known === "dialog-cursor" || known === "struct" || known === "unusable") {
    return decision("incompatible", "dynamic");
  }
  if (known === "boolean") {
    if (ordering)
      return decision("incompatible", "boolean");
    const judgment = reduceAlternativeJudgments([
      judgeFamily(left, "boolean"),
      judgeFamily(right, "boolean")
    ]);
    return { judgment, mode: "boolean" };
  }
  if (known === "number") {
    const judgment = reduceAlternativeJudgments([
      judgeFamily(left, "number"),
      judgeFamily(right, "number")
    ]);
    return { judgment, mode: "number" };
  }
  if (known === "string") {
    const judgment = reduceAlternativeJudgments([
      judgeFamily(left, "string"),
      judgeFamily(right, "string")
    ]);
    return { judgment, mode: "string" };
  }
  return decision("unknown", "dynamic");
}
function decision(kind, mode) {
  return { judgment: { kind }, mode };
}
function stableFamily(evidence) {
  switch (evidence.kind) {
    case "dynamic":
      return "dynamic";
    case "struct":
      return "struct";
    case "unusable":
      return "unusable";
    case "array":
      return "array";
    case "alternatives": {
      const families = evidence.alternatives.map(stableFamily);
      const first = families[0] ?? "dynamic";
      return families.every((family) => family === first) ? first : "dynamic";
    }
    case "fact": {
      const fact = evidence.fact;
      if (fact.kind === "literal") {
        if (typeof fact.value === "boolean")
          return "boolean";
        if (typeof fact.value === "string")
          return "string";
        return "number";
      }
      if (fact.kind === "carrier")
        return fact.carrier;
      if (fact.kind === "array" || fact.kind === "empty-array")
        return "array";
      if (fact.kind === "provenance") {
        return fact.provenance === "artifact" ? "artifact" : fact.provenance === "dialog-cursor" ? "dialog-cursor" : "number";
      }
      switch (fact.spec.type) {
        case "boolean":
          return "boolean";
        case "string":
        case "enum":
          return "string";
        case "number":
        case "index":
          return "number";
        case "artifact":
          return "artifact";
        case "dialogCursor":
          return "dialog-cursor";
        case "array":
          return "array";
      }
    }
  }
}
function collectArrayElementFamilies(evidence, families) {
  switch (evidence.kind) {
    case "alternatives":
      for (const alternative of evidence.alternatives) {
        collectArrayElementFamilies(alternative, families);
      }
      return;
    case "array":
      for (const element of evidence.elements) {
        collectScalarComparisonFamilies(element, families);
      }
      return;
    case "fact":
      if (evidence.fact.kind === "site" && evidence.fact.spec.type === "array") {
        families.add(arrayComparisonFamily(evidence.fact.spec.element));
      } else if (evidence.fact.kind === "array") {
        for (const element of evidence.fact.elements) {
          collectScalarComparisonFamilies({ kind: "fact", fact: element }, families);
        }
      }
      return;
    case "dynamic":
    case "struct":
    case "unusable":
      return;
  }
}
function collectScalarComparisonFamilies(evidence, families) {
  if (evidence.kind === "alternatives") {
    for (const alternative of evidence.alternatives) {
      collectScalarComparisonFamilies(alternative, families);
    }
    return;
  }
  const family = stableFamily(evidence);
  if (family === "boolean" || family === "string" || family === "number" || family === "artifact") {
    families.add(family);
  }
}
function judgeArrayEvidence(evidence, elementFamily) {
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "alternatives":
      return reduceAlternativeJudgments(evidence.alternatives.map((alternative) => judgeArrayEvidence(alternative, elementFamily)));
    case "array":
      return reduceAlternativeJudgments(evidence.elements.map((element) => judgeScalarComparisonEvidence(element, elementFamily)));
    case "fact":
      if (evidence.fact.kind === "empty-array") {
        return { kind: "compatible" };
      }
      if (evidence.fact.kind === "array") {
        return reduceAlternativeJudgments(evidence.fact.elements.map((element) => judgeScalarComparisonEvidence({ kind: "fact", fact: element }, elementFamily)));
      }
      if (evidence.fact.kind === "site" && evidence.fact.spec.type === "array") {
        const family = arrayComparisonFamily(evidence.fact.spec.element);
        return elementFamily === void 0 || family === elementFamily ? { kind: "compatible" } : { kind: "incompatible" };
      }
      return { kind: "incompatible" };
    case "struct":
    case "unusable":
      return { kind: "incompatible" };
  }
}
function judgeScalarComparisonEvidence(evidence, family) {
  if (family !== void 0)
    return judgeFamily(evidence, family);
  if (evidence.kind === "dynamic")
    return { kind: "unknown" };
  if (evidence.kind === "alternatives") {
    return reduceAlternativeJudgments(evidence.alternatives.map((alternative) => judgeScalarComparisonEvidence(alternative, family)));
  }
  const stable = stableFamily(evidence);
  return stable === "boolean" || stable === "string" || stable === "number" || stable === "artifact" ? { kind: "compatible" } : { kind: "incompatible" };
}
function arrayComparisonFamily(spec2) {
  return spec2.type === "enum" ? "string" : spec2.type;
}
function judgeFamily(evidence, family) {
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "alternatives":
      return reduceAlternativeJudgments(evidence.alternatives.map((alternative) => judgeFamily(alternative, family)));
    default:
      return stableFamily(evidence) === family ? { kind: "compatible" } : { kind: "incompatible" };
  }
}
function admitArrayComparisonValues(elementFamily, left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return operationViolation("invalid-array-operation", "Array equality requires array operands");
  }
  if (elementFamily === "artifact") {
    const spec3 = {
      type: "array",
      element: { type: "artifact" }
    };
    const admittedLeft2 = admitValue(spec3, left);
    const admittedRight2 = admitValue(spec3, right);
    return admittedLeft2.admitted && admittedRight2.admitted ? operationAdmitted({ left, right }) : operationViolation("invalid-array-operation", "Artifact array equality requires valid Artifact elements");
  }
  const nonFinitePath = firstNonFiniteNumberPath(left) ?? firstNonFiniteNumberPath(right);
  if (nonFinitePath !== void 0) {
    return operationViolation("non-finite-number", `Numeric value must be finite before numeric comparison${nonFinitePath === "$" ? "" : ` at ${nonFinitePath}`}`);
  }
  const concreteFamily = concreteArrayElementFamily(left, right);
  if (concreteFamily === "incompatible") {
    return operationViolation("invalid-array-operation", "Array equality requires one shared boolean, string, or number element family");
  }
  const selectedFamily = elementFamily ?? concreteFamily;
  if (selectedFamily === void 0) {
    return operationAdmitted({ left, right });
  }
  if (elementFamily !== void 0 && concreteFamily !== void 0 && concreteFamily !== elementFamily) {
    return operationViolation("invalid-array-operation", `Array equality requires ${elementFamily} elements`);
  }
  const spec2 = {
    type: "array",
    element: { type: selectedFamily }
  };
  const admittedLeft = admitValue(spec2, left);
  const admittedRight = admitValue(spec2, right);
  return admittedLeft.admitted && admittedRight.admitted ? operationAdmitted({ left, right }) : operationViolation("invalid-array-operation", `Array equality requires ${selectedFamily} elements`);
}
function concreteArrayElementFamily(left, right) {
  let family;
  for (const element of [...left, ...right]) {
    const current2 = typeof element === "boolean" || typeof element === "string" || typeof element === "number" ? elementTypeFamily(element) : void 0;
    if (current2 === void 0)
      return "incompatible";
    if (family !== void 0 && current2 !== family)
      return "incompatible";
    family = current2;
  }
  return family;
}
function elementTypeFamily(value) {
  return typeof value === "boolean" ? "boolean" : typeof value === "string" ? "string" : "number";
}
function provenEnumDomain(evidence) {
  if (evidence.kind === "fact" && evidence.fact.kind === "site" && evidence.fact.spec.type === "enum") {
    return evidence.fact.spec.values;
  }
  if (evidence.kind !== "alternatives" || evidence.alternatives.length === 0) {
    return void 0;
  }
  const domains = evidence.alternatives.map(provenEnumDomain);
  const first = domains[0];
  return first && domains.every((domain) => domain && sameEnumDomain(first, domain)) ? first : void 0;
}
function judgeEnumOperand(evidence, domain) {
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "alternatives":
      return reduceAlternativeJudgments(evidence.alternatives.map((alternative) => judgeEnumOperand(alternative, domain)));
    case "fact":
      if (evidence.fact.kind === "literal") {
        return typeof evidence.fact.value === "string" && domain.includes(evidence.fact.value) ? { kind: "compatible" } : { kind: "incompatible" };
      }
      if (evidence.fact.kind === "site" && evidence.fact.spec.type === "enum" && sameEnumDomain(evidence.fact.spec.values, domain)) {
        return { kind: "compatible" };
      }
      return { kind: "incompatible" };
    default:
      return { kind: "incompatible" };
  }
}
function sameEnumDomain(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function judgeBooleanEvidence(evidence) {
  return judgeFamily(evidence, "boolean");
}
function judgeStringEvidence(evidence) {
  return judgeFamily(evidence, "string");
}
function judgeInterpolationEvidence(evidence) {
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "unusable":
    case "struct":
      return { kind: "incompatible" };
    case "alternatives":
      return reduceAlternativeJudgments(evidence.alternatives.map(judgeInterpolationEvidence));
    case "array":
      return reduceAlternativeJudgments(evidence.elements.map(judgePrimitiveArrayElementInterpolation));
    case "fact": {
      if (evidence.fact.kind === "site" && evidence.fact.spec.type === "array") {
        return evidence.fact.spec.element.type === "artifact" ? { kind: "incompatible" } : { kind: "compatible" };
      }
      if (evidence.fact.kind === "array") {
        return reduceAlternativeJudgments(evidence.fact.elements.map((element) => judgePrimitiveArrayElementInterpolation({
          kind: "fact",
          fact: element
        })));
      }
      const family = stableFamily(evidence);
      return family === "boolean" || family === "string" || family === "number" || family === "artifact" || family === "array" ? { kind: "compatible" } : { kind: "incompatible" };
    }
  }
}
function judgePrimitiveArrayElementInterpolation(evidence) {
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "alternatives":
      return reduceAlternativeJudgments(evidence.alternatives.map(judgePrimitiveArrayElementInterpolation));
    default: {
      const family = stableFamily(evidence);
      return family === "boolean" || family === "string" || family === "number" ? { kind: "compatible" } : { kind: "incompatible" };
    }
  }
}
function operationAdmitted(value) {
  return { admitted: true, value };
}
function operationViolation(code, detail) {
  return { admitted: false, violation: { code, detail } };
}
function judgeNumericEvidence(evidence) {
  switch (evidence.kind) {
    case "dynamic":
      return { kind: "unknown" };
    case "unusable":
    case "struct":
    case "array":
      return { kind: "incompatible" };
    case "alternatives":
      return reduceAlternativeJudgments(evidence.alternatives.map(judgeNumericEvidence));
    case "fact": {
      const fact = evidence.fact;
      if (fact.kind === "literal") {
        return typeof fact.value === "number" ? { kind: "compatible" } : { kind: "incompatible" };
      }
      if (fact.kind === "carrier") {
        return fact.carrier === "number" ? { kind: "compatible" } : { kind: "incompatible" };
      }
      if (fact.kind === "provenance") {
        return fact.provenance === "index" ? { kind: "compatible" } : { kind: "incompatible" };
      }
      if (fact.kind === "site") {
        return fact.spec.type === "number" || fact.spec.type === "index" ? { kind: "compatible" } : { kind: "incompatible" };
      }
      return { kind: "incompatible" };
    }
  }
}
function resolvedFact(fact) {
  return { kind: "fact", fact };
}
function hostParameterChannelSpec(spec2) {
  switch (spec2.type) {
    case "boolean":
    case "string":
    case "number":
    case "index":
    case "artifact":
    case "dialogCursor":
      return { type: spec2.type };
    case "enum":
      return { type: "enum", values: spec2.values };
    case "array": {
      const element = spec2.element;
      if (element.type !== "boolean" && element.type !== "string" && element.type !== "enum" && element.type !== "number" && element.type !== "artifact") {
        return void 0;
      }
      return {
        type: "array",
        element: element.type === "enum" ? { type: "enum", values: element.values } : { type: element.type }
      };
    }
    case "tuple":
    case "struct":
    case "semanticText":
      return void 0;
  }
}
function judgeSemanticArgument(semantic, destination, context) {
  if (semantic.kind === "literal") {
    return judgeOneTimeLanding({ kind: "literal", value: semantic.value }, destination);
  }
  let dynamic = false;
  for (const part of semantic.parts) {
    if (part.kind === "ref" || part.kind === "hostVar") {
      return { kind: "incompatible" };
    }
    if (part.kind !== "expression")
      continue;
    const evidence = resolveProducer(part.expression, context);
    if (producerGuaranteesArtifact(evidence)) {
      return { kind: "incompatible" };
    }
    if (producerMayProduceArtifact(evidence))
      dynamic = true;
  }
  if (destination.type === "enum")
    return { kind: "unknown" };
  return dynamic ? { kind: "unknown" } : { kind: "compatible" };
}
function producerMayProduceArtifact(evidence) {
  switch (evidence.kind) {
    case "dynamic":
      return true;
    case "alternatives":
      return evidence.alternatives.some(producerMayProduceArtifact);
    case "fact":
      return evidence.fact.kind === "provenance" && evidence.fact.provenance === "artifact" || evidence.fact.kind === "site" && evidence.fact.spec.type === "artifact";
    default:
      return false;
  }
}
function resolveArrayElementSpec(reference, context) {
  if (reference.kind === "channel") {
    const spec2 = context.signature?.[reference.namespace][reference.key];
    return spec2?.type === "array" ? spec2.element : void 0;
  }
  const cell = findCell(context, reference.name);
  return cell?.type === "array" ? cell.element : void 0;
}
function findCell(context, name2) {
  const resolved = context.resolveCell?.(name2);
  if (resolved)
    return resolved;
  for (let index = context.cells.length - 1; index >= 0; index -= 1) {
    const candidate = context.cells[index];
    if (candidate.name === name2)
      return candidate;
  }
  return void 0;
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/types/parser.js
var UNSTAMPED_ID = "";
function isObservableCell(cell) {
  return isObservableCellSpec(cell);
}
function isArrayCell(cell) {
  return cell.type === "array";
}
function isScalarObservableCell(cell) {
  return isObservableCell(cell) && cell.type !== "array";
}
function isValueExpressionCell(cell) {
  return isObservableCell(cell) || cell.type === "array" || cell.type === "dialogCursor" || cell.type === "artifact";
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/types/runtime.js
function nodeSegKey(kind) {
  return kind;
}
function invokeSegKey(invoke) {
  return invoke;
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/parser/targets.js
function parseTarget(expression, mode, context) {
  const label = targetLabel(mode);
  if (!expression || expression.type === "SpreadElement") {
    throw new Error(`${label} requires a target`);
  }
  if (expression.type === "Identifier") {
    return parseBareTarget(expression.name, mode, context);
  }
  if (mode === "deflectionEscaped") {
    throw new Error("this.deflection.escaped() only accepts a bare target");
  }
  if (expression.type === "CallExpression" && expression.callee.type === "Identifier" && (expression.callee.name === "forgetful" || expression.callee.name === "newcopy")) {
    const targetMode = expression.callee.name;
    if (expression.arguments.length !== 1) {
      throw new Error(`${targetMode}() accepts exactly one node or imported arc identifier`);
    }
    const targetArg = expression.arguments[0];
    if (!targetArg || targetArg.type === "SpreadElement" || targetArg.type !== "Identifier") {
      throw new Error(`${targetMode}() requires a node or imported arc identifier`);
    }
    return {
      ...parseBareTarget(targetArg.name, mode, context),
      mode: targetMode
    };
  }
  throw new Error(`${label} requires a node/import identifier or forgetful(node/import) or newcopy(node/import)`);
}
function resolvesToEnclosing(identifier, context) {
  const { enclosing, availableImports } = context;
  return enclosing !== void 0 && identifier === enclosing.identifier && !enclosing.childNames.has(identifier) && !availableImports.has(identifier);
}
function parseBareTarget(identifier, mode, context) {
  const { availableImports, visibleNodeNames } = context;
  if (resolvesToEnclosing(identifier, context)) {
    if (mode !== "deflectionEscaped") {
      throw new Error(`${targetLabel(mode)} cannot re-enter the enclosing node ${identifier}`);
    }
    return { identifier, imported: false, mode: "canonical" };
  }
  if (!visibleNodeNames.has(identifier) && !availableImports.has(identifier)) {
    throw new Error(`Unknown node: ${identifier}`);
  }
  return {
    identifier,
    imported: availableImports.has(identifier) && !visibleNodeNames.has(identifier),
    mode: "canonical"
  };
}
function targetLabel(mode) {
  if (mode === "enter")
    return "$enter()";
  if (mode === "enterLoop")
    return "$enterLoop()";
  return "this.deflection.escaped()";
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/parser/ast.js
function getName(node2) {
  if (node2?.type !== "Identifier")
    return void 0;
  return node2.name;
}
function getThisProperty(node2) {
  if (!node2 || node2.type !== "MemberExpression")
    return void 0;
  if (node2.object.type !== "ThisExpression")
    return void 0;
  return getName(node2.property);
}
function getMemberTarget(node2) {
  if (!node2 || node2.type !== "MemberExpression")
    return void 0;
  const object = getName(node2.object);
  const property = getName(node2.property);
  if (!object || !property)
    return void 0;
  return { object, property };
}
function locOf(node2) {
  if (!node2 || !("loc" in node2) || !node2.loc)
    return void 0;
  return {
    start: { line: node2.loc.start.line, column: node2.loc.start.column + 1 },
    end: { line: node2.loc.end.line, column: node2.loc.end.column + 1 }
  };
}
function getFunctionBody(node2) {
  if (!node2)
    return void 0;
  if (node2.type === "FunctionExpression" || node2.type === "ArrowFunctionExpression") {
    if (node2.body.type === "BlockStatement") {
      return node2.body.body;
    }
  }
  return void 0;
}
function getHookBodyStatements(node2, conciseAs) {
  if (!node2 || node2.type !== "ArrowFunctionExpression")
    return void 0;
  if (node2.body.type === "BlockStatement") {
    return node2.body.body;
  }
  const expression = node2.body;
  const wrapped = conciseAs === "return" ? {
    type: "ReturnStatement",
    argument: expression,
    start: expression.start,
    end: expression.end,
    loc: expression.loc
  } : {
    type: "ExpressionStatement",
    expression,
    start: expression.start,
    end: expression.end,
    loc: expression.loc
  };
  return [wrapped];
}
function getBlockStatements(node2) {
  return node2.type === "BlockStatement" ? node2.body : [node2];
}
function expressionToLocalExpression(node2, availableHostModules = /* @__PURE__ */ new Map(), briefable, context) {
  if (node2.type === "Literal") {
    const value = node2.value;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return { kind: "literal", value };
    }
  }
  if (node2.type === "Identifier") {
    return { kind: "cell", name: node2.name };
  }
  if (node2.type === "BinaryExpression") {
    if (!isArithmeticOperator(node2.operator)) {
      throw new Error(`Unsupported local binary operator: ${node2.operator}`);
    }
    return {
      kind: "arithmetic",
      op: node2.operator,
      left: expressionToLocalExpression(node2.left, availableHostModules, briefable, context),
      right: expressionToLocalExpression(node2.right, availableHostModules, briefable, context)
    };
  }
  if (node2.type === "UnaryExpression" && node2.operator === "-") {
    return {
      kind: "numericUnary",
      op: "-",
      argument: expressionToLocalExpression(node2.argument, availableHostModules, briefable, context)
    };
  }
  if (node2.type === "MemberExpression") {
    if (node2.computed) {
      const array2 = parseArrayReference(node2.object, availableHostModules);
      if (!array2) {
        throw new Error("Computed member access is not supported in Arc");
      }
      if (node2.property.type === "PrivateIdentifier") {
        throw new Error("Array index cannot be a private identifier");
      }
      return {
        kind: "arrayElementRead",
        array: array2,
        index: expressionToLocalExpression(node2.property, availableHostModules, briefable, context)
      };
    }
    if (node2.object.type === "Identifier" && node2.object.name === "Dialog" && node2.property.type === "Identifier" && node2.property.name === "lastUserMessage") {
      return { kind: "scope", name: "lastUserMessage" };
    }
    if (node2.object.type === "Identifier" && node2.object.name === "Dialog" && node2.property.type === "Identifier" && node2.property.name === "cursor") {
      return { kind: "dialogCursor" };
    }
    if (node2.object.type === "Identifier" && node2.object.name === "State" && node2.property.type === "Identifier") {
      return {
        kind: "literal",
        value: node2.property.name.toLowerCase()
      };
    }
    if (node2.object.type === "Identifier" && node2.property.type === "Identifier" && node2.property.name === "state") {
      return { kind: "nodeState", identifier: node2.object.name };
    }
    if (node2.property.type === "Identifier" && node2.property.name === "length") {
      const array2 = parseArrayReference(node2.object, availableHostModules);
      if (array2)
        return { kind: "arrayLength", array: array2 };
    }
    if (node2.object.type === "Identifier" && (node2.object.name === "args" || node2.object.name === "returns") && node2.property.type === "Identifier") {
      return {
        kind: "channel",
        namespace: node2.object.name,
        key: node2.property.name
      };
    }
    if (node2.object.type === "Identifier" && node2.object.name === "span" && node2.property.type === "Identifier" && (node2.property.name === "item" || node2.property.name === "index")) {
      return { kind: "span", owner: "map", key: node2.property.name };
    }
  }
  if (node2.type === "CallExpression") {
    if (node2.callee.type === "MemberExpression" && node2.callee.object.type === "Identifier" && node2.callee.object.name === "Dialog" && node2.callee.property.type === "Identifier" && node2.callee.property.name === "lastTurns") {
      const arg = node2.arguments[0];
      if (node2.arguments.length !== 1 || !arg || arg.type === "SpreadElement" || arg.type !== "Literal" || typeof arg.value !== "number" || !Number.isSafeInteger(arg.value) || arg.value < 0) {
        throw new Error("Dialog.lastTurns() count must be a non-negative safe-integer literal");
      }
      const count = arg.value;
      return { kind: "scope", name: "lastTurns", count };
    }
  }
  if (node2.type === "MemberExpression") {
    if (!node2.computed && node2.object.type === "MemberExpression" && !node2.object.computed && getThisProperty(node2.object) === "interruption" && node2.property.type === "Identifier" && (node2.property.name === "id" || node2.property.name === "reason")) {
      if (!context?.allowInterruption) {
        throw new Error("this.interruption is only available inside this.catchInterruption");
      }
      return {
        kind: node2.property.name === "id" ? "interruptionId" : "interruptionReason"
      };
    }
    const prop = getThisProperty(node2);
    if (prop === "enterCount") {
      return { kind: "enterCount" };
    }
    if (prop === "pendingState") {
      if (!context?.allowPendingState) {
        throw new Error("this.pendingState is only available inside this.effects");
      }
      return { kind: "pendingState" };
    }
  }
  throw new Error(`Unsupported value expression: ${node2.type}`);
}
function parseCellTarget(node2, availableHostModules = /* @__PURE__ */ new Map(), context) {
  if (node2.type === "Identifier") {
    if (availableHostModules.has(node2.name)) {
      throw new Error(`Cell target cannot use host module ${node2.name}`);
    }
    return [node2.name];
  }
  if (node2.type !== "MemberExpression" || node2.object.type === "Super") {
    throw new Error("Cell target must start from a cell identifier");
  }
  const target2 = parseCellTarget(node2.object, availableHostModules, context);
  if (!node2.computed) {
    if (node2.property.type !== "Identifier") {
      throw new Error("Cell target property must be an identifier");
    }
    return [...target2, { kind: "literal", value: node2.property.name }];
  }
  if (node2.property.type === "PrivateIdentifier") {
    throw new Error("Cell target accessor cannot be a private identifier");
  }
  return [
    ...target2,
    expressionToLocalExpression(node2.property, availableHostModules, true, context)
  ];
}
function parseArrayReference(node2, availableHostModules) {
  if (node2.type === "Identifier") {
    if (availableHostModules.has(node2.name))
      return void 0;
    return { kind: "cell", name: node2.name };
  }
  if (node2.type === "MemberExpression" && !node2.computed && node2.object.type === "Identifier" && (node2.object.name === "args" || node2.object.name === "returns") && node2.property.type === "Identifier") {
    return {
      kind: "channel",
      namespace: node2.object.name,
      key: node2.property.name
    };
  }
  return void 0;
}
function parseExpression(node2, availableHostModules = /* @__PURE__ */ new Map(), briefable, context) {
  if (node2.type === "TemplateLiteral") {
    const template = parseTemplateString(node2, availableHostModules, briefable, context);
    const parts = [];
    for (const part of template.parts) {
      if (part.kind === "ref" || part.kind === "hostVar") {
        throw new Error("Template literal contains semantic-only interpolation in value position");
      }
      parts.push(part);
    }
    return { kind: "template-string", parts };
  }
  if (node2.type === "ArrayExpression") {
    return {
      kind: "arrayLiteral",
      elements: node2.elements.map((element) => {
        if (!element || element.type === "SpreadElement") {
          throw new Error("Array literals do not support holes or spread");
        }
        return parseExpression(element, availableHostModules, briefable, context);
      })
    };
  }
  if (node2.type === "LogicalExpression") {
    if (node2.operator !== "&&" && node2.operator !== "||") {
      throw new Error(`Unsupported logical operator: ${node2.operator}`);
    }
    return {
      kind: "logical",
      op: node2.operator,
      left: parseExpression(node2.left, availableHostModules, briefable, context),
      right: parseExpression(node2.right, availableHostModules, briefable, context)
    };
  }
  if (node2.type === "UnaryExpression") {
    if (node2.operator === "-") {
      return {
        kind: "numericUnary",
        op: "-",
        argument: parseExpression(node2.argument, availableHostModules, briefable, context)
      };
    }
    if (node2.operator !== "!") {
      throw new Error(`Unsupported unary operator: ${node2.operator}`);
    }
    return {
      kind: "unary",
      op: "!",
      argument: parseExpression(node2.argument, availableHostModules, briefable, context)
    };
  }
  if (node2.type === "BinaryExpression") {
    if (isArithmeticOperator(node2.operator)) {
      return {
        kind: "arithmetic",
        op: node2.operator,
        left: parseExpression(node2.left, availableHostModules, briefable, context),
        right: parseExpression(node2.right, availableHostModules, briefable, context)
      };
    }
    if (!isComparisonOperator(node2.operator)) {
      throw new Error(`Unsupported binary operator: ${node2.operator}`);
    }
    return {
      kind: "comparison",
      op: node2.operator,
      left: parseExpression(node2.left, availableHostModules, briefable, context),
      right: parseExpression(node2.right, availableHostModules, briefable, context)
    };
  }
  if (node2.type === "ConditionalExpression") {
    return {
      kind: "conditional",
      test: parseExpression(node2.test, availableHostModules, briefable, context),
      consequent: parseExpression(node2.consequent, availableHostModules, briefable, context),
      alternate: parseExpression(node2.alternate, availableHostModules, briefable, context)
    };
  }
  if (node2.type === "CallExpression") {
    if (node2.callee.type === "Identifier" && node2.callee.name === "Artifact") {
      return parseArtifactConstructCall(node2, "Artifact value", availableHostModules, briefable, context);
    }
    if (isNumIsFiniteCall(node2, availableHostModules)) {
      const arg = node2.arguments[0];
      if (node2.arguments.length !== 1 || !arg || arg.type === "SpreadElement") {
        throw new Error("Num.isFinite() accepts exactly one argument");
      }
      return {
        kind: "numIsFinite",
        argument: parseExpression(arg, availableHostModules, briefable, context)
      };
    }
    if (node2.callee.type === "MemberExpression" && !node2.callee.computed && node2.callee.object.type === "Identifier" && !availableHostModules.has(node2.callee.object.name) && node2.callee.property.type === "Identifier" && node2.callee.property.name === "isUnset") {
      if (node2.arguments.length !== 0) {
        throw new Error("cell.isUnset() does not accept arguments");
      }
      return {
        kind: "isUnset",
        cell: node2.callee.object.name
      };
    }
    if (node2.callee.type === "MemberExpression" && !node2.callee.computed && node2.callee.object.type === "MemberExpression" && !node2.callee.object.computed && node2.callee.object.object.type === "Identifier" && (node2.callee.object.object.name === "args" || node2.callee.object.object.name === "returns") && node2.callee.object.property.type === "Identifier" && node2.callee.property.type === "Identifier" && node2.callee.property.name === "isUnset") {
      if (node2.arguments.length !== 0) {
        throw new Error("channel.isUnset() does not accept arguments");
      }
      return {
        kind: "channelIsUnset",
        namespace: node2.callee.object.object.name,
        key: node2.callee.object.property.name
      };
    }
    if (isDeflectionEscapedCall(node2)) {
      if (!context?.deflectionTargets) {
        throw new Error("this.deflection.escaped(...) is only available inside this.catchDeflection or this.effects");
      }
      if (node2.arguments.length !== 1) {
        throw new Error("this.deflection.escaped() accepts exactly one target");
      }
      return {
        kind: "deflectionEscaped",
        target: parseTarget(node2.arguments[0], "deflectionEscaped", context.deflectionTargets)
      };
    }
    if (isDialogLastTurnsCall(node2)) {
      return expressionToLocalExpression(node2, availableHostModules, briefable);
    }
    if (isDialogTurnsSinceCall(node2, availableHostModules)) {
      return parseDialogTurnsSinceCall(node2, availableHostModules, briefable);
    }
    if (node2.callee.type !== "Super") {
      const hostCallTarget = parseHostCallTarget(node2.callee, availableHostModules);
      if (hostCallTarget) {
        if (hostCallTarget.operation.startsWith("$")) {
          throw new Error("$-prefixed host operations are only valid as standalone action statements");
        }
        if (!briefable) {
          throw new Error("Host call expressions are not allowed in this position");
        }
        return {
          id: UNSTAMPED_ID,
          kind: "host-call",
          module: hostCallTarget.module,
          target: hostCallTarget.path,
          operation: hostCallTarget.operation,
          arguments: node2.arguments.map((arg) => {
            if (arg.type === "SpreadElement") {
              throw new Error("Host calls do not support spread arguments");
            }
            return parseHostCallArgument(arg, availableHostModules, briefable, context);
          }),
          loc: locOf(node2)
        };
      }
    }
    if (isJudgeCall(node2)) {
      const arg = node2.arguments[0];
      if (!arg || arg.type === "SpreadElement") {
        throw new Error("judge() expects semantic text");
      }
      if (!briefable) {
        throw new Error("judge() is not allowed in this position");
      }
      return {
        id: UNSTAMPED_ID,
        kind: "judge",
        question: parseSemanticString(arg, availableHostModules, context),
        loc: locOf(node2)
      };
    }
    if (isRegexTest(node2)) {
      const callee = node2.callee;
      const object = callee.object;
      const target2 = node2.arguments[0];
      if (!target2 || target2.type === "SpreadElement") {
        throw new Error("Regex test requires a target");
      }
      const regex = object.regex;
      if (!regex) {
        throw new Error("Regex literal metadata missing");
      }
      return {
        kind: "regexTest",
        pattern: regex.pattern,
        flags: regex.flags,
        target: expressionToLocalExpression(target2, availableHostModules, briefable, context)
      };
    }
  }
  return expressionToLocalExpression(node2, availableHostModules, briefable, context);
}
function parseArtifactConstructCall(call, owner, availableHostModules, briefable, context) {
  if (call.arguments.length !== 1) {
    throw new Error(`${owner} requires one path argument`);
  }
  const argument = call.arguments[0];
  if (!argument || argument.type === "SpreadElement") {
    throw new Error(`${owner} path does not support spread`);
  }
  let path;
  try {
    path = parseExpression(argument, availableHostModules, briefable, context);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`${owner} path must be a value expression${detail}`);
  }
  if (path.kind === "literal" && typeof path.value === "string") {
    const issue2 = classifyArtifactPath(path.value);
    if (issue2 !== void 0) {
      throw new Error(`${owner} path ${describeArtifactPathIssue(issue2)}`);
    }
  }
  return { kind: "artifact", path };
}
function isArithmeticOperator(operator) {
  return operator === "+" || operator === "-" || operator === "*" || operator === "/" || operator === "%";
}
function isComparisonOperator(operator) {
  return operator === "==" || operator === "!=" || operator === ">" || operator === ">=" || operator === "<" || operator === "<=";
}
function isNumIsFiniteCall(node2, availableHostModules) {
  return !availableHostModules.has("Num") && node2.callee.type === "MemberExpression" && !node2.callee.computed && node2.callee.object.type === "Identifier" && node2.callee.object.name === "Num" && node2.callee.property.type === "Identifier" && node2.callee.property.name === "isFinite";
}
function isDeflectionEscapedCall(node2) {
  return node2.callee.type === "MemberExpression" && !node2.callee.computed && node2.callee.object.type === "MemberExpression" && !node2.callee.object.computed && node2.callee.object.object.type === "ThisExpression" && node2.callee.object.property.type === "Identifier" && node2.callee.object.property.name === "deflection" && node2.callee.property.type === "Identifier" && node2.callee.property.name === "escaped";
}
function parseHostCallTarget(expression, availableHostModules) {
  if (expression.type !== "MemberExpression")
    return void 0;
  const operation = getStaticMemberSegment(expression);
  if (!operation) {
    throw new Error("Host calls do not support computed member access");
  }
  if (expression.object.type === "Super") {
    throw new Error("Host calls do not support super member access");
  }
  const parent = parseHostCallTargetRoot(expression.object, availableHostModules);
  if (!parent)
    return void 0;
  return {
    module: parent.module,
    path: parent.path,
    operation
  };
}
function parseHostCallTargetRoot(expression, availableHostModules) {
  if (expression.type === "Identifier") {
    const module = availableHostModules.get(expression.name);
    if (!module)
      return void 0;
    return { module, path: [] };
  }
  if (expression.type !== "MemberExpression")
    return void 0;
  const segment = getStaticMemberSegment(expression);
  if (!segment) {
    throw new Error("Host calls do not support computed member access");
  }
  if (expression.object.type === "Super") {
    throw new Error("Host calls do not support super member access");
  }
  const parent = parseHostCallTargetRoot(expression.object, availableHostModules);
  if (!parent)
    return void 0;
  return {
    module: parent.module,
    path: [...parent.path, segment]
  };
}
function isDialogLastTurnsCall(node2) {
  return node2.callee.type === "MemberExpression" && !node2.callee.computed && node2.callee.object.type === "Identifier" && node2.callee.object.name === "Dialog" && node2.callee.property.type === "Identifier" && node2.callee.property.name === "lastTurns";
}
function isDialogTurnsSinceCall(node2, availableHostModules) {
  if (node2.callee.type !== "MemberExpression" || node2.callee.computed || node2.callee.property.type !== "Identifier") {
    return false;
  }
  const method = node2.callee.property.name;
  if (method !== "userTurnsSince" && method !== "selfTurnsSince" && method !== "totalTurnsSince") {
    return false;
  }
  const receiver = node2.callee.object;
  if (isDialogCursorAccess(receiver))
    return true;
  return receiver.type === "Identifier" && !availableHostModules.has(receiver.name);
}
function isDialogCursorAccess(node2) {
  return node2.type === "MemberExpression" && !node2.computed && node2.object.type === "Identifier" && node2.object.name === "Dialog" && node2.property.type === "Identifier" && node2.property.name === "cursor";
}
function parseDialogTurnsSinceCall(node2, availableHostModules, briefable) {
  const callee = node2.callee;
  const operation = callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : void 0;
  if (operation !== "userTurnsSince" && operation !== "selfTurnsSince" && operation !== "totalTurnsSince") {
    throw new Error("Unsupported cursor turn-difference method");
  }
  const receiverNode = callee.object;
  if (receiverNode.type === "Identifier" && receiverNode.name === "Dialog") {
    throw new Error(`Dialog.${operation}() was replaced by cursor methods; call ${operation}() on a cursor value, e.g. Dialog.cursor.${operation}(startedAt)`);
  }
  if (node2.arguments.length !== 1) {
    throw new Error(`.${operation}() accepts exactly one cursor`);
  }
  const arg = node2.arguments[0];
  if (!arg || arg.type === "SpreadElement") {
    throw new Error(`.${operation}() requires a cursor`);
  }
  if (receiverNode.type === "Super") {
    throw new Error(`.${operation}() has no valid cursor receiver`);
  }
  return {
    kind: "dialogTurnsSince",
    metric: operation === "userTurnsSince" ? "user" : operation === "selfTurnsSince" ? "self" : "total",
    receiver: expressionToLocalExpression(receiverNode, availableHostModules, briefable),
    baseline: expressionToLocalExpression(arg, availableHostModules, briefable)
  };
}
function parseHostCallArgument(expression, availableHostModules = /* @__PURE__ */ new Map(), briefable, context) {
  if (expression.type === "TemplateLiteral" || expression.type === "Literal" && typeof expression.value === "string") {
    return {
      kind: "semantic",
      value: parseSemanticString(expression, availableHostModules, context)
    };
  }
  if (expression.type === "ArrayExpression") {
    return {
      kind: "array",
      elements: expression.elements.map((element) => {
        if (!element || element.type === "SpreadElement") {
          throw new Error("Host call arrays do not support holes or spread");
        }
        return parseHostCallArgument(element, availableHostModules, briefable, context);
      })
    };
  }
  if (expression.type === "ObjectExpression") {
    const value2 = {};
    for (const property of expression.properties) {
      if (property.type === "SpreadElement") {
        throw new Error("Host call objects do not support spread");
      }
      if (property.computed) {
        throw new Error("Host call objects do not support computed keys");
      }
      if (property.kind !== "init" || property.method) {
        throw new Error("Host call objects require data properties");
      }
      const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : void 0;
      if (!key) {
        throw new Error("Host call objects require identifier or string keys");
      }
      if (!isHostStructFieldName(key)) {
        throw new Error("Host call object keys cannot be __proto__, prototype, or constructor");
      }
      if (Object.hasOwn(value2, key)) {
        throw new Error(`Duplicate host call object key ${JSON.stringify(key)}`);
      }
      value2[key] = parseHostCallArgument(property.value, availableHostModules, briefable, context);
    }
    return { kind: "object", value: value2 };
  }
  const value = parseExpression(expression, availableHostModules, briefable, context);
  if (containsBriefableExpression(value)) {
    throw new Error("Host call arguments cannot contain briefable expressions");
  }
  return {
    kind: "value",
    value
  };
}
function containsBriefableExpression(expression) {
  switch (expression.kind) {
    case "judge":
    case "host-call":
      return true;
    case "regexTest":
      return containsBriefableExpression(expression.target);
    case "comparison":
    case "arithmetic":
    case "logical":
      return containsBriefableExpression(expression.left) || containsBriefableExpression(expression.right);
    case "conditional":
      return containsBriefableExpression(expression.test) || containsBriefableExpression(expression.consequent) || containsBriefableExpression(expression.alternate);
    case "unary":
    case "numericUnary":
    case "numIsFinite":
      return containsBriefableExpression(expression.argument);
    case "template-string":
      return expression.parts.some((part) => part.kind === "expression" && containsBriefableExpression(part.expression));
    case "artifact":
      return containsBriefableExpression(expression.path);
    case "arrayElementRead":
      return containsBriefableExpression(expression.index);
    case "arrayLiteral":
      return expression.elements.some((element) => containsBriefableExpression(element));
    default:
      return false;
  }
}
function isJudgeCall(node2) {
  return node2.callee.type === "Identifier" && node2.callee.name === "judge";
}
function isRegexTest(node2) {
  return node2.callee.type === "MemberExpression" && node2.callee.object.type === "Literal" && !!node2.callee.object.regex && node2.callee.property.type === "Identifier" && node2.callee.property.name === "test";
}
function parseTemplateString(node2, availableHostModules = /* @__PURE__ */ new Map(), briefable, context) {
  const parts = [];
  for (let index = 0; index < node2.quasis.length; index++) {
    const quasi = node2.quasis[index];
    if (!quasi)
      continue;
    const rawText = quasi.value.cooked ?? quasi.value.raw;
    if (rawText.length > 0) {
      parts.push({ kind: "text", value: rawText });
    }
    const expression = node2.expressions[index];
    if (expression) {
      const participant = matchDialogParticipantReference(expression);
      if (participant) {
        parts.push({ kind: "ref", name: participant });
        continue;
      }
      const hostVar = matchHostVarReference(expression, availableHostModules);
      if (hostVar) {
        parts.push({
          kind: "hostVar",
          module: hostVar.module,
          path: hostVar.path
        });
        continue;
      }
      parts.push({
        kind: "expression",
        expression: parseExpression(expression, availableHostModules, briefable, context)
      });
    }
  }
  return {
    kind: "template-string",
    parts
  };
}
function matchDialogParticipantReference(node2) {
  if (node2.type === "Identifier" && (node2.name === "user" || node2.name === "self")) {
    return node2.name;
  }
  if (node2.type === "MemberExpression" && !node2.computed && node2.object.type === "Identifier" && node2.object.name === "Dialog" && node2.property.type === "Identifier" && (node2.property.name === "user" || node2.property.name === "self")) {
    return node2.property.name;
  }
  return void 0;
}
function parseSemanticString(node2, availableHostModules = /* @__PURE__ */ new Map(), context) {
  if (node2.type === "Literal" && typeof node2.value === "string") {
    return { kind: "literal", value: node2.value };
  }
  if (node2.type === "TemplateLiteral") {
    return parseTemplateString(node2, availableHostModules, void 0, context);
  }
  throw new Error("Semantic text must be a string or template literal");
}
function matchHostVarReference(node2, availableHostModules) {
  if (node2.type !== "MemberExpression")
    return void 0;
  return walkHostVarMemberChain(node2, availableHostModules);
}
function walkHostVarMemberChain(node2, availableHostModules) {
  if (node2.type === "Identifier") {
    const module = availableHostModules.get(node2.name);
    if (!module)
      return void 0;
    return { module, path: [] };
  }
  if (node2.type !== "MemberExpression")
    return void 0;
  const segment = getStaticMemberSegment(node2);
  if (!segment)
    return void 0;
  if (node2.object.type === "Super")
    return void 0;
  const parent = walkHostVarMemberChain(node2.object, availableHostModules);
  if (!parent)
    return void 0;
  return {
    module: parent.module,
    path: [...parent.path, segment]
  };
}
function getStaticMemberSegment(node2) {
  if (!node2.computed && node2.property.type === "Identifier") {
    return node2.property.name;
  }
  if (node2.computed && node2.property.type === "Literal" && typeof node2.property.value === "string" && node2.property.value.length > 0) {
    return node2.property.value;
  }
  return void 0;
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/spec/validation.js
function validateHostModuleSpec(value) {
  const issues = [];
  validateHostNamespace(value, "$", issues, { visiting: /* @__PURE__ */ new WeakSet() });
  return issues;
}
function validateHostNamespace(value, path, issues, state) {
  const object = inspectHostSpecObject(value, path, issues);
  if (!object)
    return;
  if (!enterHostSpecObject(object, path, issues, state))
    return;
  try {
    if (!exactHostSpecKeys(object, ["kind", "members"], path, issues))
      return;
    if (object.kind !== "namespace") {
      hostSpecIssue(issues, `${path}.kind`, 'expected "namespace"');
      return;
    }
    const membersPath = `${path}.members`;
    const members = inspectHostSpecObject(object.members, membersPath, issues);
    if (!members)
      return;
    for (const [name2, member] of Object.entries(members)) {
      if (name2.length === 0 || name2.startsWith("$")) {
        hostSpecIssue(issues, `${membersPath}[${JSON.stringify(name2)}]`, "member names must be nonempty and cannot begin with $");
        continue;
      }
      const memberPath = `${membersPath}[${JSON.stringify(name2)}]`;
      const memberObject = inspectHostSpecObject(member, memberPath, issues);
      if (!memberObject)
        continue;
      if (memberObject.kind === "namespace") {
        validateHostNamespace(member, memberPath, issues, state);
      } else if (memberObject.kind === "operation") {
        validateHostOperation(member, memberPath, issues, state);
      } else {
        hostSpecIssue(issues, `${memberPath}.kind`, "expected namespace or operation");
      }
    }
  } finally {
    state.visiting.delete(object);
  }
}
function validateHostOperation(value, path, issues, state) {
  const object = inspectHostSpecObject(value, path, issues);
  if (!object)
    return;
  if (!enterHostSpecObject(object, path, issues, state))
    return;
  try {
    if (!exactHostSpecKeys(object, ["kind", "parameters", "returns"], path, issues, ["returns"])) {
      return;
    }
    if (object.kind !== "operation") {
      hostSpecIssue(issues, `${path}.kind`, 'expected "operation"');
      return;
    }
    const parameters = inspectHostSpecArray(object.parameters, `${path}.parameters`, issues);
    if (!parameters)
      return;
    const parameterIssueCount = issues.length;
    parameters.forEach((parameter, index) => {
      const parameterPath = `${path}.parameters[${index}]`;
      validateHostParameterSpec(parameter, parameterPath, "parameter", issues, state);
    });
    if (issues.length === parameterIssueCount) {
      let omittable = false;
      parameters.forEach((parameter, index) => {
        if (parameter.type === "omittable") {
          omittable = true;
        } else if (omittable) {
          hostSpecIssue(issues, `${path}.parameters[${index}]`, "required parameters cannot follow omittable parameters");
        }
      });
    }
    if (Object.hasOwn(object, "returns")) {
      validateHostParameterSpec(object.returns, `${path}.returns`, "result", issues, state);
    }
  } finally {
    state.visiting.delete(object);
  }
}
function validateHostParameterSpec(value, path, context, issues, state) {
  const object = inspectHostSpecObject(value, path, issues);
  if (!object)
    return;
  if (!enterHostSpecObject(object, path, issues, state))
    return;
  try {
    const type = object.type;
    if (typeof type !== "string") {
      hostSpecIssue(issues, `${path}.type`, "spec type must be a string");
      return;
    }
    if (type === "omittable") {
      if (context !== "parameter" && context !== "field") {
        hostSpecIssue(issues, path, "omittable specs are only valid around a whole parameter or Struct field");
        return;
      }
      if (!exactHostSpecKeys(object, ["type", "spec"], path, issues))
        return;
      validateHostParameterSpec(object.spec, `${path}.spec`, "argument", issues, state);
      return;
    }
    if (type === "array") {
      if (!exactHostSpecKeys(object, ["type", "element"], path, issues)) {
        return;
      }
      if (context === "result") {
        const element = inspectHostSpecObject(object.element, `${path}.element`, issues);
        if (!element)
          return;
        if (element.type !== "boolean" && element.type !== "string" && element.type !== "enum" && element.type !== "number" && element.type !== "artifact") {
          hostSpecIssue(issues, `${path}.element`, "result array element must be a scalar or Artifact Arc spec");
          return;
        }
        validateHostParameterSpec(object.element, `${path}.element`, "result", issues, state);
        return;
      }
      validateHostParameterSpec(object.element, `${path}.element`, "argument", issues, state);
      return;
    }
    if (type === "tuple") {
      if (context === "result") {
        hostSpecIssue(issues, path, "tuple specs are parameter-only");
        return;
      }
      if (!exactHostSpecKeys(object, ["type", "elements"], path, issues)) {
        return;
      }
      const elements = inspectHostSpecArray(object.elements, `${path}.elements`, issues);
      elements?.forEach((element, index) => validateHostParameterSpec(element, `${path}.elements[${index}]`, "argument", issues, state));
      return;
    }
    if (type === "struct") {
      if (context === "result") {
        hostSpecIssue(issues, path, "struct specs are parameter-only");
        return;
      }
      if (!exactHostSpecKeys(object, ["type", "fields"], path, issues))
        return;
      const fields = inspectHostSpecObject(object.fields, `${path}.fields`, issues);
      if (!fields)
        return;
      for (const [name2, field] of Object.entries(fields)) {
        const fieldPath2 = `${path}.fields[${JSON.stringify(name2)}]`;
        if (!isHostStructFieldName(name2)) {
          hostSpecIssue(issues, fieldPath2, "Struct field names must be nonempty and cannot be __proto__, prototype, or constructor");
          continue;
        }
        validateHostParameterSpec(field, fieldPath2, "field", issues, state);
      }
      return;
    }
    if (type === "semanticText") {
      if (context === "result") {
        hostSpecIssue(issues, path, "semanticText specs are parameter-only");
        return;
      }
      exactHostSpecKeys(object, ["type"], path, issues);
      return;
    }
    if (type === "enum") {
      if (!exactHostSpecKeys(object, ["type", "values"], path, issues)) {
        return;
      }
      const values = inspectHostSpecArray(object.values, `${path}.values`, issues);
      if (!values)
        return;
      if (values.some((entry) => typeof entry !== "string")) {
        hostSpecIssue(issues, `${path}.values`, "Enum values must be strings");
        return;
      }
    } else if (type === "boolean" || type === "string" || type === "number" || type === "index" || type === "artifact" || type === "dialogCursor") {
      if (!exactHostSpecKeys(object, ["type"], path, issues))
        return;
    } else {
      hostSpecIssue(issues, `${path}.type`, `unsupported spec type ${JSON.stringify(type)}`);
      return;
    }
    const violation2 = validateSpec(object);
    if (violation2)
      hostSpecIssue(issues, path, violation2.detail);
  } finally {
    state.visiting.delete(object);
  }
}
function enterHostSpecObject(object, path, issues, state) {
  if (state.visiting.has(object)) {
    hostSpecIssue(issues, path, "cyclic host-module spec shapes are unsupported");
    return false;
  }
  state.visiting.add(object);
  return true;
}
function inspectHostSpecObject(value, path, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    hostSpecIssue(issues, path, "expected a plain object");
    return void 0;
  }
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    hostSpecIssue(issues, path, "object shape could not be inspected");
    return void 0;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    hostSpecIssue(issues, path, "expected a plain object");
    return void 0;
  }
  for (const key of keys) {
    if (typeof key !== "string") {
      hostSpecIssue(issues, path, "symbol keys are unsupported");
      return void 0;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      hostSpecIssue(issues, `${path}[${JSON.stringify(key)}]`, "fields must be enumerable data properties");
      return void 0;
    }
  }
  return value;
}
function inspectHostSpecArray(value, path, issues) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    hostSpecIssue(issues, path, "expected an ordinary array");
    return void 0;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      hostSpecIssue(issues, `${path}[${index}]`, "arrays must be dense enumerable data");
      return void 0;
    }
  }
  const extra = Reflect.ownKeys(value).find((key) => {
    if (key === "length")
      return false;
    if (typeof key !== "string")
      return true;
    const index = Number(key);
    return !Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length;
  });
  if (extra !== void 0) {
    hostSpecIssue(issues, path, "arrays cannot contain non-element properties");
    return void 0;
  }
  return value;
}
function exactHostSpecKeys(object, allowed, path, issues, optional2 = []) {
  const keys = Object.keys(object);
  const unknown = keys.find((key) => !allowed.includes(key));
  if (unknown !== void 0) {
    hostSpecIssue(issues, `${path}[${JSON.stringify(unknown)}]`, "unsupported field");
    return false;
  }
  const missing = allowed.find((key) => !optional2.includes(key) && !Object.hasOwn(object, key));
  if (missing) {
    hostSpecIssue(issues, `${path}.${missing}`, "required field is missing");
    return false;
  }
  return true;
}
function hostSpecIssue(issues, path, detail) {
  issues.push({ code: "invalid-host-module-spec", path, detail });
}
function validateSpec(spec2) {
  if (!spec2 || typeof spec2 !== "object" || Array.isArray(spec2)) {
    return {
      code: "invalid-spec-shape",
      detail: "Spec must be an object"
    };
  }
  const object = spec2;
  if (object.type === "array") {
    if (!("element" in object)) {
      return {
        code: "invalid-spec-shape",
        detail: "Array spec requires an element spec"
      };
    }
    const elementViolation = validateSpec(object.element);
    if (elementViolation)
      return elementViolation;
    const elementType = object.element.type;
    if (elementType !== "boolean" && elementType !== "string" && elementType !== "enum" && elementType !== "number" && elementType !== "artifact") {
      return {
        code: "invalid-spec-shape",
        detail: "Array element spec must be scalar or Artifact"
      };
    }
    return void 0;
  }
  if (object.type === "enum") {
    if (!Array.isArray(object.values) || object.values.some((value) => typeof value !== "string")) {
      return {
        code: "invalid-spec-shape",
        detail: "Enum values must be an array of strings"
      };
    }
    if (object.values.length === 0) {
      return { code: "empty-enum", detail: "Enum requires at least one value" };
    }
    const seen = /* @__PURE__ */ new Set();
    for (const value of object.values) {
      if (seen.has(value)) {
        return {
          code: "duplicate-enum-value",
          detail: `Enum contains duplicate value ${JSON.stringify(value)}`
        };
      }
      seen.add(value);
    }
    return void 0;
  }
  if (object.type !== "boolean" && object.type !== "string" && object.type !== "number" && object.type !== "index" && object.type !== "artifact" && object.type !== "dialogCursor") {
    return {
      code: "invalid-spec-shape",
      detail: `Unsupported spec type ${JSON.stringify(object.type)}`
    };
  }
  return void 0;
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/parser/document-grammar.js
var fieldPath = (path, key) => `${path}[${JSON.stringify(key)}]`;
function issue(issues, path, detail, code = "INVALID_DOCUMENT_SHAPE") {
  issues.push({ code, message: `Invalid Document at ${path}: ${detail}` });
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function predicate(test, detail, code) {
  return (value, path, issues) => {
    if (!test(value))
      issue(issues, path, detail, code);
  };
}
var string = predicate((v) => typeof v === "string", "expected a string");
var name = predicate((v) => typeof v === "string" && v.length > 0, "expected a nonempty name");
var boolean = predicate((v) => typeof v === "boolean", "expected a boolean");
var number = predicate((v) => typeof v === "number", "expected a number");
var primitive = predicate((v) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean", "expected a primitive literal or null");
var oneOf = (...values) => predicate((v) => values.some((x) => x === v), `expected ${values.map((v) => JSON.stringify(v)).join(" or ")}`);
var optional = (rule) => (value, path, issues) => {
  if (value !== void 0)
    rule(value, path, issues);
};
var lazy = (get) => (value, path, issues) => get()(value, path, issues);
function coded(rule, code) {
  return (value, path, issues) => {
    const found = [];
    rule(value, path, found);
    for (const error of found)
      issues.push({
        ...error,
        code: error.code === "INVALID_DOCUMENT_SHAPE" || error.code === "INVALID_EXPRESSION_STRATUM" ? code : error.code
      });
  };
}
function refine(rule, check) {
  return (value, path, issues) => {
    const before = issues.length;
    rule(value, path, issues);
    if (issues.length === before)
      check(value, path, issues);
  };
}
function attachLocation(value, path, issues, start) {
  if (!isRecord(value) || value.loc === void 0)
    return;
  const found = [];
  location(value.loc, fieldPath(path, "loc"), found);
  if (found.length === 0)
    for (const error of issues.slice(start))
      error.loc ??= value.loc;
}
function record(fields) {
  const rules = fields;
  return (value, path, issues) => {
    if (!isRecord(value)) {
      issue(issues, path, "expected a record");
      return;
    }
    const before = issues.length;
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(rules, key))
        issue(issues, fieldPath(path, key), "unsupported field");
    }
    for (const [key, rule] of Object.entries(rules))
      rule(value[key], fieldPath(path, key), issues);
    if (Object.hasOwn(rules, "loc"))
      attachLocation(value, path, issues, before);
  };
}
function array(rule, minimum = 0) {
  return (value, path, issues) => {
    if (!Array.isArray(value)) {
      issue(issues, path, "expected an array");
      return;
    }
    if (value.length < minimum)
      issue(issues, path, `expected at least ${minimum} entries`);
    value.forEach((item, index) => rule(item, `${path}[${index}]`, issues));
  };
}
function map(rule, keyRule = name) {
  return (value, path, issues) => {
    if (!isRecord(value)) {
      issue(issues, path, "expected a named map");
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      const at2 = fieldPath(path, key);
      keyRule(key, at2, issues);
      rule(item, at2, issues);
    }
  };
}
function variants(key, rules, code) {
  return (value, path, issues) => {
    if (!isRecord(value) || typeof value[key] !== "string" || !Object.hasOwn(rules, value[key])) {
      issue(issues, path, `expected a recognized ${key}`, code);
      return;
    }
    rules[value[key]](value, path, issues);
  };
}
var position = record({
  line: predicate((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1, "line must be a positive safe integer"),
  column: predicate((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0, "column must be a non-negative safe integer")
});
var location = (value, path, issues) => {
  const before = issues.length;
  record({ start: position, end: position })(value, path, issues);
  if (issues.length === before) {
    const loc = value;
    if (loc.end.line < loc.start.line || loc.end.line === loc.start.line && loc.end.column < loc.start.column)
      issue(issues, path, "source range ends before it starts");
  }
};
var id = optional(string);
var meta = { id, loc: optional(location) };
var target = record({
  identifier: name,
  imported: boolean,
  mode: coded(oneOf("canonical", "forgetful", "newcopy"), "INVALID_TARGET_MODE")
});
var arrayReference = variants("kind", {
  cell: record({
    kind: oneOf("cell"),
    name
  }),
  channel: record({
    kind: oneOf("channel"),
    namespace: oneOf("args", "returns"),
    key: name
  })
});
var cellTarget = (value, path, issues) => {
  if (!Array.isArray(value) || value.length === 0) {
    issue(issues, path, "expected a cell target with a root");
    return;
  }
  name(value[0], `${path}[0]`, issues);
  value.slice(1).forEach((item, index) => localExpression(item, `${path}[${index + 1}]`, issues));
};
var payload = (value, path, issues) => {
  const invalid = firstInvalidPayloadValue(value);
  if (invalid)
    issue(issues, `${path}${invalid.path === "$" ? "" : invalid.path.slice(1)}`, invalid.detail, "INVALID_PAYLOAD_VALUE");
};
function expr(fields) {
  return record(fields);
}
var valueChild = lazy(() => valueExpression);
var localChild = lazy(() => localExpression);
var semanticChild = lazy(() => semanticString);
var hostChild = lazy(() => hostArgument);
var expressionRules = {
  literal: expr({ kind: oneOf("literal"), value: primitive }),
  cell: expr({ kind: oneOf("cell"), name }),
  isUnset: expr({ kind: oneOf("isUnset"), cell: name }),
  channel: expr({
    kind: oneOf("channel"),
    namespace: oneOf("args", "returns"),
    key: name
  }),
  channelIsUnset: expr({
    kind: oneOf("channelIsUnset"),
    namespace: oneOf("args", "returns"),
    key: name
  }),
  arrayElementRead: expr({
    kind: oneOf("arrayElementRead"),
    array: arrayReference,
    index: localChild
  }),
  arrayLength: expr({
    kind: oneOf("arrayLength"),
    array: arrayReference
  }),
  span: expr({
    kind: oneOf("span"),
    owner: oneOf("map"),
    key: oneOf("item", "index")
  }),
  deflectionEscaped: expr({
    kind: oneOf("deflectionEscaped"),
    target
  }),
  dialogCursor: expr({ kind: oneOf("dialogCursor") }),
  dialogTurnsSince: expr({
    kind: oneOf("dialogTurnsSince"),
    metric: oneOf("user", "self", "total"),
    receiver: localChild,
    baseline: localChild
  }),
  scope: refine(expr({
    kind: oneOf("scope"),
    name: oneOf("lastUserMessage", "lastTurns"),
    count: optional(predicate((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0, "Dialog.lastTurns count must be a non-negative safe integer", "INVALID_DIALOG_LAST_TURNS_COUNT"))
  }), (value, path, issues) => {
    const scope = value;
    if (scope.name !== "lastTurns" && scope.count !== void 0)
      issue(issues, fieldPath(path, "count"), "count belongs to Dialog.lastTurns", "INVALID_DIALOG_LAST_TURNS_COUNT");
  }),
  enterCount: expr({ kind: oneOf("enterCount") }),
  interruptionId: expr({ kind: oneOf("interruptionId") }),
  interruptionReason: expr({
    kind: oneOf("interruptionReason")
  }),
  pendingState: expr({ kind: oneOf("pendingState") }),
  nodeState: expr({ kind: oneOf("nodeState"), identifier: name }),
  arithmetic: expr({
    kind: oneOf("arithmetic"),
    op: coded(oneOf("+", "-", "*", "/", "%"), "INVALID_ARITHMETIC_OPERATOR"),
    left: valueChild,
    right: valueChild
  }),
  numericUnary: expr({
    kind: oneOf("numericUnary"),
    op: coded(oneOf("-"), "INVALID_NUMERIC_UNARY_OPERATOR"),
    argument: valueChild
  }),
  judge: expr({
    ...meta,
    kind: oneOf("judge"),
    question: semanticChild
  }),
  "host-call": expr({
    ...meta,
    kind: oneOf("host-call"),
    module: name,
    target: array(name),
    operation: name,
    arguments: coded(array(hostChild), "HOST_CALL_ARGUMENT")
  }),
  artifact: expr({
    kind: oneOf("artifact"),
    path: (value, path, issues) => {
      coded(valueChild, "INVALID_ARTIFACT_CONSTRUCT_EXPRESSION")(value, path, issues);
      if (isRecord(value) && value.kind === "literal" && typeof value.value === "string") {
        const invalid = classifyArtifactPath(value.value);
        if (invalid)
          issue(issues, fieldPath(path, "value"), describeArtifactPathIssue(invalid), "INVALID_ARTIFACT_PATH");
      }
    }
  }),
  "template-string": expr({
    kind: oneOf("template-string"),
    parts: array(lazy(() => valuePart))
  }),
  arrayLiteral: expr({
    kind: oneOf("arrayLiteral"),
    elements: array(valueChild)
  }),
  regexTest: expr({
    kind: oneOf("regexTest"),
    pattern: string,
    flags: string,
    target: localChild
  }),
  comparison: expr({
    kind: oneOf("comparison"),
    op: coded(oneOf("==", "!=", ">", ">=", "<", "<="), "INVALID_COMPARISON_OPERATOR"),
    left: valueChild,
    right: valueChild
  }),
  numIsFinite: expr({
    kind: oneOf("numIsFinite"),
    argument: (v, p, i) => v === void 0 ? issue(i, p, "expected a value-expression argument", "INVALID_NUM_IS_FINITE_EXPRESSION") : valueChild(v, p, i)
  }),
  logical: expr({
    kind: oneOf("logical"),
    op: coded(oneOf("&&", "||"), "INVALID_LOGICAL_OPERATOR"),
    left: valueChild,
    right: valueChild
  }),
  conditional: expr({
    kind: oneOf("conditional"),
    test: valueChild,
    consequent: valueChild,
    alternate: valueChild
  }),
  unary: expr({
    kind: oneOf("unary"),
    op: coded(oneOf("!"), "INVALID_LOGICAL_UNARY_OPERATOR"),
    argument: valueChild
  })
};
var localKinds = {
  literal: true,
  cell: true,
  isUnset: true,
  channel: true,
  channelIsUnset: true,
  arrayElementRead: true,
  arrayLength: true,
  span: true,
  deflectionEscaped: true,
  dialogCursor: true,
  dialogTurnsSince: true,
  scope: true,
  enterCount: true,
  interruptionId: true,
  interruptionReason: true,
  pendingState: true,
  nodeState: true,
  arithmetic: true,
  numericUnary: true
};
var localExpression = coded((value, path, issues) => {
  if (!isRecord(value) || typeof value.kind !== "string" || !Object.hasOwn(localKinds, value.kind)) {
    issue(issues, path, "expected a local expression");
    return;
  }
  if (value.kind === "arithmetic") {
    record({
      kind: oneOf("arithmetic"),
      op: coded(oneOf("+", "-", "*", "/", "%"), "INVALID_ARITHMETIC_OPERATOR"),
      left: localChild,
      right: localChild
    })(value, path, issues);
  } else if (value.kind === "numericUnary") {
    record({
      kind: oneOf("numericUnary"),
      op: coded(oneOf("-"), "INVALID_NUMERIC_UNARY_OPERATOR"),
      argument: localChild
    })(value, path, issues);
  } else
    expressionRules[value.kind](value, path, issues);
}, "INVALID_EXPRESSION_STRATUM");
var valueExpression = coded((value, path, issues) => {
  variants("kind", expressionRules)(value, path, issues);
  if (isRecord(value) && value.kind === "regexTest" && typeof value.pattern === "string" && typeof value.flags === "string") {
    try {
      new RegExp(value.pattern, value.flags);
    } catch {
      issue(issues, path, "invalid regular expression");
    }
  }
}, "INVALID_EXPRESSION_STRATUM");
var valuePart = variants("kind", {
  text: record({
    kind: oneOf("text"),
    value: string
  }),
  expression: record({
    kind: oneOf("expression"),
    expression: valueChild
  })
});
var semanticPart = variants("kind", {
  text: record({
    kind: oneOf("text"),
    value: string
  }),
  expression: record({
    kind: oneOf("expression"),
    expression: valueChild
  }),
  ref: record({
    kind: oneOf("ref"),
    name: oneOf("user", "self")
  }),
  hostVar: record({
    kind: oneOf("hostVar"),
    module: name,
    path: array(name, 1)
  })
});
var semanticString = variants("kind", {
  literal: record({
    kind: oneOf("literal"),
    value: string
  }),
  "template-string": record({
    kind: oneOf("template-string"),
    parts: array(semanticPart)
  })
});
var hostArgument = coded(variants("kind", {
  value: record({
    kind: oneOf("value"),
    value: valueChild
  }),
  semantic: record({
    kind: oneOf("semantic"),
    value: semanticChild
  }),
  array: record({
    kind: oneOf("array"),
    elements: array(hostChild)
  }),
  object: record({
    kind: oneOf("object"),
    value: map(hostChild, predicate((v) => typeof v === "string" && isHostStructFieldName(v), "invalid Struct field name"))
  })
}), "HOST_CALL_ARGUMENT");
var observeAs = coded((value, path, issues) => {
  const before = issues.length;
  record({
    kind: oneOf("number", "integer"),
    min: optional(number),
    max: optional(number)
  })(value, path, issues);
  if (issues.length !== before)
    return;
  const bounds = value;
  if (bounds.min !== void 0 && bounds.max !== void 0 && bounds.min > bounds.max)
    issue(issues, path, "bounds must satisfy min <= max");
  if (bounds.kind === "integer")
    for (const key of ["min", "max"]) {
      if (bounds[key] !== void 0 && !Number.isSafeInteger(bounds[key]))
        issue(issues, fieldPath(path, key), "integer bound must be a safe integer");
    }
}, "INVALID_NUMERIC_OBSERVE_AS");
var specTypes = {
  boolean: true,
  string: true,
  enum: true,
  number: true,
  artifact: true,
  dialogCursor: true,
  index: true,
  array: true
};
function spec(role) {
  return (value, path, issues) => {
    if (!isRecord(value)) {
      issue(issues, path, "expected a spec record", "INVALID_SPEC");
      return;
    }
    if (value.type === "rangedInt") {
      issue(issues, path, 'Source / IR numeric spec must use type "number"; found "rangedInt"', "NON_CANONICAL_NUMERIC_SPEC");
      return;
    }
    const type = value.type;
    if (typeof type !== "string" || !Object.hasOwn(specTypes, type) || role === "cell" && type === "index" || role.endsWith("element") && ["array", "index", "dialogCursor"].includes(type)) {
      issue(issues, path, "unsupported spec type for this role", "INVALID_SPEC");
      return;
    }
    const fields = { type: oneOf(type) };
    if (role === "cell")
      Object.assign(fields, { name, loc: optional(location) });
    if (type === "enum")
      fields.values = array(string);
    if (type === "array")
      fields.element = spec(role === "cell" ? "cell-element" : "channel-element");
    const observable = (role === "cell" || role === "cell-element") && ["boolean", "string", "enum", "number"].includes(type);
    if (observable)
      fields.observing = optional(semanticChild);
    if (observable && type === "number")
      fields.observeAs = optional(observeAs);
    if (role === "cell" && type === "artifact")
      fields.initializer = optional(coded((v, p, i) => {
        if (!isRecord(v) || v.kind !== "artifact")
          issue(i, p, "expected an Artifact constructor");
        else
          expressionRules.artifact(v, p, i);
      }, "INVALID_ARTIFACT_CELL_SPEC"));
    const before = issues.length;
    for (const key of Object.keys(value))
      if (!Object.hasOwn(fields, key)) {
        issue(issues, fieldPath(path, key), `unsupported field ${JSON.stringify(key)}`, key === "observeAs" ? "INVALID_NUMERIC_OBSERVE_AS" : role === "cell" && type === "artifact" && key === "path" ? "INVALID_ARTIFACT_CELL_SPEC" : "INVALID_SPEC");
      }
    for (const [key, rule] of Object.entries(fields))
      coded(rule, "INVALID_SPEC")(value[key], fieldPath(path, key), issues);
    if (role === "cell")
      attachLocation(value, path, issues, before);
    if (issues.length === before) {
      const violation2 = validateSpec(value);
      if (violation2)
        issue(issues, path, violation2.detail, "INVALID_SPEC");
    }
  };
}
function binding(direction) {
  return variants("kind", {
    cell: record({
      kind: oneOf("cell"),
      cell: name
    }),
    argsProjection: (value, path, issues) => {
      record({ kind: oneOf("argsProjection"), key: name })(value, path, issues);
      if (direction === "returns")
        issue(issues, path, "an args projection cannot be a returns sink");
    },
    span: record({
      kind: oneOf("span"),
      owner: oneOf("map"),
      key: direction === "args" ? oneOf("item", "index") : oneOf("result")
    })
  });
}
var groupTargets = refine(array(cellTarget, 1), (value, path, issues) => {
  const seen = /* @__PURE__ */ new Set();
  for (const [index, target2] of value.entries()) {
    if (target2.length !== 1)
      issue(issues, `${path}[${index}]`, "grouped observation requires direct cell targets");
    if (seen.has(target2[0]))
      issue(issues, `${path}[${index}]`, "grouped observation repeats a cell");
    seen.add(target2[0]);
  }
});
var body = (role) => array(lazy(() => statement(role)));
function stmt(fields) {
  return record(fields);
}
var commonStatement = {
  observe: true,
  observeGroup: true,
  set: true,
  unset: true,
  if: true,
  label: true,
  break: true
};
var actionKinds = {
  ...commonStatement,
  observeOrAsk: true,
  observeOrAskGroup: true,
  "set-return": true,
  "enter-node": true,
  "enter-loop": true,
  instruction: true,
  invoke: true,
  map: true,
  "set-span": true,
  "host-call": true
};
var triggerKinds = { ...commonStatement, return: true };
var catchKinds = {
  ...triggerKinds,
  observeOrAsk: true,
  observeOrAskGroup: true
};
var effectKinds = {
  ...commonStatement,
  "set-return": true,
  "host-call": true
};
function statement(role) {
  const bindings = {
    args: optional(map(binding("args"))),
    returns: optional(map(binding("returns")))
  };
  const rules = {
    observe: stmt({
      ...meta,
      kind: oneOf("observe"),
      target: cellTarget,
      question: optional(semanticChild)
    }),
    observeOrAsk: stmt({
      ...meta,
      kind: oneOf("observeOrAsk"),
      target: cellTarget,
      question: optional(semanticChild)
    }),
    observeGroup: stmt({
      ...meta,
      kind: oneOf("observeGroup"),
      targets: groupTargets
    }),
    observeOrAskGroup: stmt({
      ...meta,
      kind: oneOf("observeOrAskGroup"),
      targets: groupTargets
    }),
    set: stmt({
      ...meta,
      kind: oneOf("set"),
      target: cellTarget,
      value: valueChild
    }),
    unset: stmt({ ...meta, kind: oneOf("unset"), target: cellTarget }),
    "set-return": stmt({
      ...meta,
      kind: oneOf("set-return"),
      key: name,
      value: valueChild
    }),
    "set-span": stmt({
      ...meta,
      kind: oneOf("set-span"),
      owner: oneOf("map"),
      value: valueChild
    }),
    break: stmt({ ...meta, kind: oneOf("break"), label: name }),
    return: stmt({
      ...meta,
      kind: oneOf("return"),
      value: optional(valueChild)
    }),
    if: stmt({
      ...meta,
      kind: oneOf("if"),
      test: valueChild,
      consequent: body(role),
      alternate: optional(body(role))
    }),
    label: stmt({
      ...meta,
      kind: oneOf("label"),
      label: name,
      body: body(role)
    }),
    "enter-node": stmt({
      ...meta,
      ...bindings,
      kind: oneOf("enter-node"),
      target
    }),
    "enter-loop": stmt({
      ...meta,
      ...bindings,
      kind: oneOf("enter-loop"),
      target,
      resolveWhen: body("resolution")
    }),
    instruction: refine(stmt({
      ...meta,
      kind: oneOf("instruction"),
      mode: oneOf("once", "persistent"),
      template: semanticChild,
      hostParams: optional(payload),
      resolveWhen: optional(body("resolution")),
      deflectWhen: optional(body("resolution")),
      inheritedDeflectWhen: optional(boolean)
    }), (value, path, issues) => {
      const instruction = value;
      const resolutionIssue = instructionResolutionIssue(instruction);
      if (resolutionIssue)
        issue(issues, fieldPath(path, "resolveWhen"), resolutionIssue);
      if (instruction.inheritedDeflectWhen && instruction.deflectWhen === void 0)
        issue(issues, fieldPath(path, "deflectWhen"), "an inherited deflectWhen requires its hook body");
    }),
    invoke: stmt({
      ...meta,
      kind: oneOf("invoke"),
      body: body("action")
    }),
    map: stmt({
      ...meta,
      kind: oneOf("map"),
      receiver: arrayReference,
      results: optional(name),
      body: body("action")
    }),
    "host-call": expressionRules["host-call"]
  };
  const allowed = role === "action" ? actionKinds : role === "catch" ? catchKinds : role === "effects" ? effectKinds : triggerKinds;
  return (value, path, issues) => {
    if (!isRecord(value) || typeof value.kind !== "string" || !Object.hasOwn(allowed, value.kind)) {
      issue(issues, path, `expected a statement allowed in ${role}`);
      return;
    }
    rules[value.kind](value, path, issues);
  };
}
function instructionResolutionIssue(instruction) {
  if (instruction.mode === "persistent" && instruction.resolveWhen === void 0)
    return "$instructLoop() requires resolveWhen";
  if (instruction.mode === "once" && instruction.resolveWhen !== void 0)
    return "$instruct() does not support resolveWhen";
  return void 0;
}
function isReservedChannelKey(key) {
  return key === "state" || key === "length" || key === "isUnset";
}
var channelKey = predicate((v) => typeof v === "string" && v.length > 0 && !isReservedChannelKey(v), "expected an unreserved channel name", "INVALID_CHANNEL_KEY");
var signature = record({
  args: map(spec("channel"), channelKey),
  returns: map(spec("channel"), channelKey)
});
var node = lazy(() => record({
  identifier: name,
  displayName: optional(string),
  description: optional(string),
  guidance: optional(semanticChild),
  hostParams: optional(payload),
  forgetfulEntry: boolean,
  writeDiffMode: coded(oneOf("rewalk", "advance"), "INVALID_WRITE_DIFF_MODE"),
  signature: optional(signature),
  cells: array(spec("cell")),
  statements: body("action"),
  children: array(node),
  newcopyAliases: array(record({
    identifier: name,
    target: name,
    imported: boolean
  })),
  imports: array(name),
  trigger: optional(body("trigger")),
  deflectWhen: optional(body("resolution")),
  catchDeflection: optional(body("catch")),
  catchInterruption: optional(body("catch")),
  guard: optional(body("guard")),
  effects: optional(body("effects")),
  loc: optional(location)
}));
var documentGrammar = record({
  imports: array(record({
    importedName: name,
    localName: name,
    source: name,
    loc: optional(location)
  })),
  hostModules: array(record({
    module: name,
    localName: name,
    importedName: oneOf("default"),
    source: name,
    loc: optional(location)
  })),
  roots: array(node, 1)
});
function validateDocumentStructure(document, issues) {
  const seen = /* @__PURE__ */ new WeakSet();
  const active = /* @__PURE__ */ new WeakSet();
  const reject = (path, detail) => {
    issues.push({
      code: "INVALID_PUBLIC_IR",
      message: `Invalid public IR at ${path}: ${detail}`
    });
  };
  const visit = (value, path) => {
    if (value === void 0 || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return;
    }
    if (typeof value !== "object") {
      reject(path, `unsupported ${typeof value} value`);
      return;
    }
    if (active.has(value)) {
      reject(path, "cyclic references are not allowed");
      return;
    }
    if (seen.has(value))
      return;
    seen.add(value);
    active.add(value);
    let prototype;
    let keys;
    try {
      prototype = Object.getPrototypeOf(value);
      keys = Reflect.ownKeys(value);
    } catch {
      active.delete(value);
      reject(path, "object shape could not be inspected");
      return;
    }
    const descriptorAt = (key) => {
      try {
        return Object.getOwnPropertyDescriptor(value, key);
      } catch {
        reject(`${path}[${JSON.stringify(key)}]`, "property descriptor could not be inspected");
        return void 0;
      }
    };
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        reject(path, "arrays must use the ordinary Array prototype");
      } else {
        const length = descriptorAt("length")?.value;
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptorAt(String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            reject(`${path}[${index}]`, "arrays must contain dense enumerable data elements");
            continue;
          }
          visit(descriptor.value, `${path}[${index}]`);
        }
        for (const key of keys) {
          if (key === "length")
            continue;
          if (typeof key !== "string" || !Number.isSafeInteger(Number(key)) || Number(key) < 0 || String(Number(key)) !== key || Number(key) >= length) {
            reject(typeof key === "string" ? `${path}[${JSON.stringify(key)}]` : path, "arrays cannot contain non-element properties");
          }
        }
      }
      active.delete(value);
      return;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      reject(path, "objects must use a plain or null prototype");
      active.delete(value);
      return;
    }
    for (const key of keys) {
      if (typeof key !== "string") {
        reject(path, "objects cannot contain symbol keys");
        continue;
      }
      const descriptor = descriptorAt(key);
      const fieldPath2 = `${path}[${JSON.stringify(key)}]`;
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        reject(fieldPath2, "fields must be enumerable data properties");
        continue;
      }
      visit(descriptor.value, fieldPath2);
    }
    active.delete(value);
  };
  visit(document, "$");
  if (issues.length > 0)
    return;
  const numericSeen = /* @__PURE__ */ new WeakSet();
  const numbers = (value, path) => {
    if (typeof value === "number" && !Number.isFinite(value))
      issues.push({
        code: "NON_FINITE_NUMBER",
        message: `Document contains a non-finite number at ${path}`
      });
    if (value === null || typeof value !== "object" || numericSeen.has(value))
      return;
    numericSeen.add(value);
    if (Array.isArray(value))
      value.forEach((item, index) => numbers(item, `${path}[${index}]`));
    else
      for (const [key, item] of Object.entries(value))
        numbers(item, fieldPath(path, key));
  };
  numbers(document, "$");
  if (issues.length === 0)
    documentGrammar(document, "$", issues);
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/parser/lint.js
var LINT_RULES = {
  "canonical-enter-loop-retained-frame": {
    severity: "warning",
    message: "$enterLoop() preserves a covered canonical target; use newcopy(...) or forgetful(...) to repeat completed work."
  },
  "unguarded-invoke": {
    severity: "warning",
    message: "invoke() is reached unconditionally and runs an unconditional action, so that work repeats on every walk or re-walk that reaches it; guard the effects inside it unless the repeated run is intended."
  },
  "invoke-unconditional-set": {
    severity: "notice",
    message: "invoke() writes a cell unconditionally, so the write re-applies on every reach; if another action later writes the same cell, the re-run can overwrite it. Make the re-application deliberate or guard the write."
  },
  "invoke-self-mutating-set": {
    severity: "error",
    message: "invoke() write derives a cell from its own current value without a guard, so it re-applies on every reach and may never reach a fixpoint (e.g. a boolean toggle `flag.$set(flag !== true)`, or a string that keeps growing); guard the write so it settles, or replace it with a value independent of its prior state."
  },
  "nested-invoke": {
    severity: "warning",
    message: "Nested invoke() creates stacked reactive statement graphs."
  },
  "boolean-toggle-set": {
    severity: "notice",
    message: "Bool cell is set to both true and false in this arc; action-graph $set() actions resolve and are remembered, so toggles and resets should be modeled deliberately."
  },
  "bare-cell-boolean": {
    severity: "warning",
    message: "Bare cell is evaluated as a boolean; an unset value poisons the traversal. Use an explicit comparison for value tests, or cell.isUnset() when testing whether the cell has a value."
  },
  "read-without-assignment": {
    severity: "error",
    message: "Cell is read but never set \u2014 by $set(), $observe()/$observeOrAsk(), or an enter returns binding \u2014 anywhere it is in scope; the read therefore always reaches an unset cell. Set it before it is read, or remove the read."
  },
  "read-before-assignment": {
    severity: "notice",
    message: "Cell is read before $set(), $observe()/$observeOrAsk(), or an enter returns binding sets it on this path; on the first walk the read reaches an unset cell. Set it before the read, or guard the read until it is set."
  }
};
function cellTargetRoot(target2) {
  return target2[0];
}
function isDirectCellTarget(target2) {
  return target2.length === 1;
}
function lintNodeStatements(node2, context) {
  for (const statement2 of node2.statements) {
    lintStatement(statement2, { ...context, branchDepth: 0 });
  }
}
function lintNodeBareCellBooleans(node2, lintIssues) {
  for (const statements of [
    node2.statements,
    node2.trigger,
    node2.guard,
    node2.deflectWhen,
    node2.catchDeflection,
    node2.catchInterruption,
    node2.effects
  ]) {
    lintBareCellBooleansInStatements(statements ?? [], lintIssues);
  }
  if (node2.guidance && semanticStringContainsBareCellBoolean(node2.guidance)) {
    emitLintIssue(lintIssues, "bare-cell-boolean", node2.loc);
  }
  for (const cell of node2.cells) {
    const observing = isScalarObservableCell(cell) ? cell.observing : isArrayCell(cell) && cell.element.type !== "artifact" ? cell.element.observing : void 0;
    if (observing && semanticStringContainsBareCellBoolean(observing)) {
      emitLintIssue(lintIssues, "bare-cell-boolean", cell.loc);
    }
    if (cell.type === "artifact" && cell.initializer !== void 0 && expressionContainsBareCellBoolean(cell.initializer.path, false)) {
      emitLintIssue(lintIssues, "bare-cell-boolean", cell.loc);
    }
  }
}
function lintRootArc(root, lintIssues) {
  const writes = /* @__PURE__ */ new Map();
  collectBooleanLiteralSets(root, /* @__PURE__ */ new Map(), writes);
  for (const scopeWrites of writes.values()) {
    for (const entry of scopeWrites.values()) {
      if (entry.trueLoc && entry.falseLoc) {
        emitLintIssue(lintIssues, "boolean-toggle-set", entry.falseLoc);
      }
    }
  }
}
function emitLintIssue(issues, code, loc) {
  const rule = LINT_RULES[code];
  issues.push({
    code,
    severity: rule.severity,
    message: rule.message,
    loc
  });
}
function invokeBodyHasUnconditionalEffect(statements) {
  for (const statement2 of statements) {
    if (statement2.kind === "if" || statement2.kind === "break")
      continue;
    if (statement2.kind === "label") {
      if (invokeBodyHasUnconditionalEffect(statement2.body))
        return true;
      continue;
    }
    return true;
  }
  return false;
}
function lintStatement(statement2, context) {
  if (statement2.kind === "if") {
    statement2.consequent.forEach((entry) => lintStatement(entry, {
      ...context,
      branchDepth: context.branchDepth + 1
    }));
    statement2.alternate?.forEach((entry) => lintStatement(entry, {
      ...context,
      branchDepth: context.branchDepth + 1
    }));
    return;
  }
  if (statement2.kind === "label") {
    statement2.body.forEach((entry) => lintStatement(entry, context));
    return;
  }
  if (statement2.kind === "break")
    return;
  if (statement2.kind === "invoke") {
    if (context.inInvoke) {
      emitLintIssue(context.lintIssues, "nested-invoke", statement2.loc);
    } else if (context.branchDepth === 0 && invokeBodyHasUnconditionalEffect(statement2.body)) {
      emitLintIssue(context.lintIssues, "unguarded-invoke", statement2.loc);
    }
    for (const entry of statement2.body) {
      lintStatement(entry, { ...context, inInvoke: true, branchDepth: 0 });
    }
    return;
  }
  if (statement2.kind === "enter-loop") {
    const targetNode = statement2.target.imported || statement2.target.mode !== "canonical" ? void 0 : context.nodeLookup.get(statement2.target.identifier);
    if (targetNode) {
      emitLintIssue(context.lintIssues, "canonical-enter-loop-retained-frame", statement2.loc);
    }
    return;
  }
  if (context.inInvoke && context.branchDepth === 0 && (statement2.kind === "set" || statement2.kind === "unset")) {
    const root = cellTargetRoot(statement2.target);
    emitLintIssue(context.lintIssues, statement2.kind === "set" && isNonConvergentSelfWrite(statement2.value, root, context.cellTypes.get(root)) ? "invoke-self-mutating-set" : "invoke-unconditional-set", statement2.loc);
  }
}
function lintBareCellBooleansInStatements(statements, lintIssues) {
  for (const statement2 of statements) {
    let containsBareBoolean = false;
    switch (statement2.kind) {
      case "if":
        containsBareBoolean = expressionContainsBareCellBoolean(statement2.test, true);
        lintBareCellBooleansInStatements(statement2.consequent, lintIssues);
        lintBareCellBooleansInStatements(statement2.alternate ?? [], lintIssues);
        break;
      case "label":
      case "invoke":
        lintBareCellBooleansInStatements(statement2.body, lintIssues);
        break;
      case "set":
      case "set-return":
        containsBareBoolean = expressionContainsBareCellBoolean(statement2.value, false);
        break;
      case "unset":
        break;
      case "return":
        containsBareBoolean = statement2.value !== void 0 && expressionContainsBareCellBoolean(statement2.value, true);
        break;
      case "observe":
      case "observeOrAsk":
        containsBareBoolean = statement2.question !== void 0 && semanticStringContainsBareCellBoolean(statement2.question);
        break;
      case "instruction":
        containsBareBoolean = semanticStringContainsBareCellBoolean(statement2.template);
        lintBareCellBooleansInStatements(statement2.resolveWhen ?? [], lintIssues);
        lintBareCellBooleansInStatements(statement2.deflectWhen ?? [], lintIssues);
        break;
      case "enter-loop":
        lintBareCellBooleansInStatements(statement2.resolveWhen, lintIssues);
        break;
      case "host-call":
        containsBareBoolean = statement2.arguments.some(hostCallArgumentContainsBareCellBoolean);
        break;
      default:
        break;
    }
    if (containsBareBoolean) {
      emitLintIssue(lintIssues, "bare-cell-boolean", statement2.loc);
    }
  }
}
function semanticStringContainsBareCellBoolean(value) {
  return value.kind === "template-string" && value.parts.some((part) => part.kind === "expression" && expressionContainsBareCellBoolean(part.expression, false));
}
function hostCallArgumentContainsBareCellBoolean(arg) {
  if (arg.kind === "semantic") {
    return semanticStringContainsBareCellBoolean(arg.value);
  }
  if (arg.kind === "value") {
    return expressionContainsBareCellBoolean(arg.value, false);
  }
  if (arg.kind === "array") {
    return arg.elements.some(hostCallArgumentContainsBareCellBoolean);
  }
  return Object.values(arg.value).some(hostCallArgumentContainsBareCellBoolean);
}
function expressionContainsBareCellBoolean(expression, booleanPosition) {
  if (expression.kind === "cell")
    return booleanPosition;
  switch (expression.kind) {
    case "comparison":
    case "arithmetic":
      return expressionContainsBareCellBoolean(expression.left, false) || expressionContainsBareCellBoolean(expression.right, false);
    case "logical":
      return expressionContainsBareCellBoolean(expression.left, true) || expressionContainsBareCellBoolean(expression.right, true);
    case "conditional":
      return expressionContainsBareCellBoolean(expression.test, true) || expressionContainsBareCellBoolean(expression.consequent, booleanPosition) || expressionContainsBareCellBoolean(expression.alternate, booleanPosition);
    case "unary":
    case "numericUnary":
    case "numIsFinite":
      return expressionContainsBareCellBoolean(expression.argument, true);
    case "regexTest":
      return expressionContainsBareCellBoolean(expression.target, false);
    case "dialogTurnsSince":
      return expressionContainsBareCellBoolean(expression.receiver, false) || expressionContainsBareCellBoolean(expression.baseline, false);
    case "template-string":
      return expression.parts.some((part) => part.kind === "expression" && expressionContainsBareCellBoolean(part.expression, false));
    case "artifact":
      return expressionContainsBareCellBoolean(expression.path, false);
    case "judge":
      return semanticStringContainsBareCellBoolean(expression.question);
    case "host-call":
      return expression.arguments.some(hostCallArgumentContainsBareCellBoolean);
    default:
      return false;
  }
}
function collectBooleanLiteralSets(node2, inheritedDeclarations, writes) {
  const declarations = new Map(inheritedDeclarations);
  for (const cell of node2.cells) {
    if (cell.type === "boolean") {
      declarations.set(cell.name, node2);
    }
  }
  collectBooleanLiteralSetsFromStatements(node2.statements, declarations, writes);
  collectBooleanLiteralSetsFromStatements(node2.trigger ?? [], declarations, writes);
  collectBooleanLiteralSetsFromStatements(node2.deflectWhen ?? [], declarations, writes);
  collectBooleanLiteralSetsFromStatements(node2.guard ?? [], declarations, writes);
  collectBooleanLiteralSetsFromStatements([...node2.catchDeflection ?? [], ...node2.catchInterruption ?? []], declarations, writes);
  collectBooleanLiteralSetsFromStatements(node2.effects ?? [], declarations, writes);
  for (const child of node2.children) {
    collectBooleanLiteralSets(child, declarations, writes);
  }
}
function collectBooleanLiteralSetsFromStatements(statements, declarations, writes) {
  for (const statement2 of statements) {
    if (statement2.kind === "if") {
      collectBooleanLiteralSetsFromStatements(statement2.consequent, declarations, writes);
      collectBooleanLiteralSetsFromStatements(statement2.alternate ?? [], declarations, writes);
      continue;
    }
    if (statement2.kind === "label" || statement2.kind === "invoke") {
      collectBooleanLiteralSetsFromStatements(statement2.body, declarations, writes);
      continue;
    }
    if (statement2.kind !== "set")
      continue;
    if (!isDirectCellTarget(statement2.target))
      continue;
    const literal2 = booleanSetLiteral(statement2.value);
    const root = cellTargetRoot(statement2.target);
    const declaringNode = declarations.get(root);
    if (literal2 === void 0 || declaringNode === void 0)
      continue;
    let scopeWrites = writes.get(declaringNode);
    if (scopeWrites === void 0) {
      scopeWrites = /* @__PURE__ */ new Map();
      writes.set(declaringNode, scopeWrites);
    }
    const entry = scopeWrites.get(root) ?? {};
    if (literal2)
      entry.trueLoc ??= statement2.loc;
    else
      entry.falseLoc ??= statement2.loc;
    scopeWrites.set(root, entry);
  }
}
function booleanSetLiteral(expression) {
  if (expression.kind !== "literal" || typeof expression.value !== "boolean") {
    return void 0;
  }
  return expression.value;
}
function isNonConvergentSelfWrite(value, cell, cellType) {
  if (!expressionReadsCell(value, cell))
    return false;
  if (value.kind === "cell" && value.name === cell)
    return false;
  if (cellType !== "boolean")
    return true;
  const whenSelfTrue = evalSelfRange(value, cell, true);
  const whenSelfFalse = evalSelfRange(value, cell, false);
  return whenSelfTrue.canBeFalse && whenSelfFalse.canBeTrue;
}
var SELF_RANGE_UNKNOWN = { canBeTrue: true, canBeFalse: true };
function evalSelfRange(expression, cell, selfValue) {
  switch (expression.kind) {
    case "literal":
      if (typeof expression.value !== "boolean")
        return SELF_RANGE_UNKNOWN;
      return expression.value ? { canBeTrue: true, canBeFalse: false } : { canBeTrue: false, canBeFalse: true };
    case "cell":
      if (expression.name !== cell)
        return SELF_RANGE_UNKNOWN;
      return selfValue ? { canBeTrue: true, canBeFalse: false } : { canBeTrue: false, canBeFalse: true };
    case "unary": {
      const argument = evalSelfRange(expression.argument, cell, selfValue);
      return { canBeTrue: argument.canBeFalse, canBeFalse: argument.canBeTrue };
    }
    case "comparison": {
      const equality = expression.op === "==" || expression.op === "!=";
      if (!equality)
        return SELF_RANGE_UNKNOWN;
      const left = evalSelfRange(expression.left, cell, selfValue);
      const right = evalSelfRange(expression.right, cell, selfValue);
      const canEqual = left.canBeTrue && right.canBeTrue || left.canBeFalse && right.canBeFalse;
      const canDiffer = left.canBeTrue && right.canBeFalse || left.canBeFalse && right.canBeTrue;
      return expression.op === "==" ? { canBeTrue: canEqual, canBeFalse: canDiffer } : { canBeTrue: canDiffer, canBeFalse: canEqual };
    }
    case "logical": {
      const left = evalSelfRange(expression.left, cell, selfValue);
      const right = evalSelfRange(expression.right, cell, selfValue);
      if (expression.op === "&&") {
        return {
          canBeTrue: left.canBeTrue && right.canBeTrue,
          canBeFalse: left.canBeFalse || left.canBeTrue && right.canBeFalse
        };
      }
      return {
        canBeTrue: left.canBeTrue || left.canBeFalse && right.canBeTrue,
        canBeFalse: left.canBeFalse && right.canBeFalse
      };
    }
    case "conditional": {
      const test = evalSelfRange(expression.test, cell, selfValue);
      const consequent = evalSelfRange(expression.consequent, cell, selfValue);
      const alternate = evalSelfRange(expression.alternate, cell, selfValue);
      return {
        canBeTrue: test.canBeTrue && consequent.canBeTrue || test.canBeFalse && alternate.canBeTrue,
        canBeFalse: test.canBeTrue && consequent.canBeFalse || test.canBeFalse && alternate.canBeFalse
      };
    }
    default:
      return SELF_RANGE_UNKNOWN;
  }
}
function expressionReadsCell(expression, cell) {
  const reads = /* @__PURE__ */ new Set();
  collectExpressionReads(expression, reads);
  return reads.has(cell);
}
function collectExpressionReads(expression, into) {
  switch (expression.kind) {
    case "cell":
      into.add(expression.name);
      return;
    case "isUnset":
      into.add(expression.cell);
      return;
    case "regexTest":
      collectExpressionReads(expression.target, into);
      return;
    case "dialogTurnsSince":
      collectExpressionReads(expression.receiver, into);
      collectExpressionReads(expression.baseline, into);
      return;
    case "comparison":
    case "arithmetic":
    case "logical":
      collectExpressionReads(expression.left, into);
      collectExpressionReads(expression.right, into);
      return;
    case "conditional":
      collectExpressionReads(expression.test, into);
      collectExpressionReads(expression.consequent, into);
      collectExpressionReads(expression.alternate, into);
      return;
    case "unary":
    case "numericUnary":
    case "numIsFinite":
      collectExpressionReads(expression.argument, into);
      return;
    case "template-string":
      for (const part of expression.parts) {
        if (part.kind === "expression") {
          collectExpressionReads(part.expression, into);
        }
      }
      return;
    case "artifact":
      collectExpressionReads(expression.path, into);
      return;
    case "host-call":
      for (const arg of expression.arguments) {
        collectHostCallArgumentReads(arg, into);
      }
      return;
    case "arrayElementRead":
      if (expression.array.kind === "cell")
        into.add(expression.array.name);
      collectExpressionReads(expression.index, into);
      return;
    case "arrayLength":
      if (expression.array.kind === "cell")
        into.add(expression.array.name);
      return;
    case "arrayLiteral":
      for (const element of expression.elements) {
        collectExpressionReads(element, into);
      }
      return;
    default:
      return;
  }
}
function collectHostCallArgumentReads(arg, into) {
  if (arg.kind === "value") {
    collectExpressionReads(arg.value, into);
  } else if (arg.kind === "array") {
    for (const item of arg.elements)
      collectHostCallArgumentReads(item, into);
  } else if (arg.kind === "object") {
    for (const item of Object.values(arg.value)) {
      collectHostCallArgumentReads(item, into);
    }
  }
}
function collectReadsAndWrites(statements, onRead, onWrite) {
  for (const statement2 of statements) {
    switch (statement2.kind) {
      case "if":
        emitExpressionReads(statement2.test, statement2.loc, onRead);
        collectReadsAndWrites(statement2.consequent, onRead, onWrite);
        collectReadsAndWrites(statement2.alternate ?? [], onRead, onWrite);
        break;
      case "label":
      case "invoke":
        collectReadsAndWrites(statement2.body, onRead, onWrite);
        break;
      case "set":
        emitCellTargetReads(statement2.target, statement2.loc, onRead);
        emitExpressionReads(statement2.value, statement2.loc, onRead);
        if (isDirectCellTarget(statement2.target)) {
          onWrite(cellTargetRoot(statement2.target), statement2.loc);
        }
        break;
      case "unset":
        break;
      case "observe":
      case "observeOrAsk":
        emitCellTargetReads(statement2.target, statement2.loc, onRead);
        if (statement2.question) {
          emitSemanticReads(statement2.question, statement2.loc, onRead);
        }
        if (isDirectCellTarget(statement2.target)) {
          onWrite(cellTargetRoot(statement2.target), statement2.loc);
        }
        break;
      case "observeGroup":
      case "observeOrAskGroup":
        for (const target2 of statement2.targets) {
          emitCellTargetReads(target2, statement2.loc, onRead);
          if (isDirectCellTarget(target2)) {
            onWrite(cellTargetRoot(target2), statement2.loc);
          }
        }
        break;
      case "map":
        if (statement2.receiver.kind === "cell") {
          onRead(statement2.receiver.name, statement2.loc);
        }
        collectReadsAndWrites(statement2.body, onRead, onWrite);
        if (statement2.results)
          onWrite(statement2.results, statement2.loc);
        break;
      case "set-span":
      case "set-return":
        emitExpressionReads(statement2.value, statement2.loc, onRead);
        break;
      case "return":
        if (statement2.value) {
          emitExpressionReads(statement2.value, statement2.loc, onRead);
        }
        break;
      case "enter-node":
        emitChannelUses(statement2.args, statement2.loc, onRead);
        emitChannelUses(statement2.returns, statement2.loc, onWrite);
        break;
      case "enter-loop":
        emitChannelUses(statement2.args, statement2.loc, onRead);
        emitChannelUses(statement2.returns, statement2.loc, onWrite);
        collectReadsAndWrites(statement2.resolveWhen, onRead, onWrite);
        break;
      case "instruction":
        emitSemanticReads(statement2.template, statement2.loc, onRead);
        collectReadsAndWrites(statement2.resolveWhen ?? [], onRead, onWrite);
        collectReadsAndWrites(statement2.deflectWhen ?? [], onRead, onWrite);
        break;
      case "host-call": {
        const reads = /* @__PURE__ */ new Set();
        for (const arg of statement2.arguments) {
          collectHostCallArgumentReads(arg, reads);
        }
        for (const name2 of reads)
          onRead(name2, statement2.loc);
        break;
      }
      default:
        break;
    }
  }
}
function emitExpressionReads(expression, loc, onRead) {
  const reads = /* @__PURE__ */ new Set();
  collectExpressionReads(expression, reads);
  for (const name2 of reads)
    onRead(name2, loc);
}
function emitCellTargetReads(target2, loc, onRead) {
  const [root, ...accessors] = target2;
  if (accessors.length === 0)
    return;
  onRead(root, loc);
  for (const accessor of accessors) {
    emitExpressionReads(accessor, loc, onRead);
  }
}
function collectSemanticStringReads(value, into) {
  if (value.kind === "literal")
    return;
  for (const part of value.parts) {
    if (part.kind === "expression")
      collectExpressionReads(part.expression, into);
  }
}
function emitSemanticReads(value, loc, onRead) {
  const reads = /* @__PURE__ */ new Set();
  collectSemanticStringReads(value, reads);
  for (const name2 of reads)
    onRead(name2, loc);
}
function emitChannelUses(bindings, loc, use) {
  if (!bindings)
    return;
  for (const source of Object.values(bindings)) {
    if (source.kind === "cell")
      use(source.cell, loc);
  }
}
function lintArcCellReads(root, lintIssues) {
  const firstRead = /* @__PURE__ */ new Map();
  const assigned = /* @__PURE__ */ new Set();
  collectArcCellUsage(root, /* @__PURE__ */ new Map(), firstRead, assigned);
  for (const [cell, loc] of firstRead) {
    if (!assigned.has(cell)) {
      emitLintIssue(lintIssues, "read-without-assignment", loc ?? cell.loc);
    }
  }
}
function collectArcCellUsage(node2, inheritedDeclarations, firstRead, assigned) {
  const declarations = new Map(inheritedDeclarations);
  for (const cell of node2.cells) {
    const name2 = cell.name;
    if (isValueExpressionCell(cell))
      declarations.set(name2, cell);
    else
      declarations.delete(name2);
  }
  const onRead = (name2, loc) => {
    const cell = declarations.get(name2);
    if (cell && !firstRead.has(cell))
      firstRead.set(cell, loc);
  };
  const onWrite = (name2) => {
    const cell = declarations.get(name2);
    if (cell)
      assigned.add(cell);
  };
  for (const cell of node2.cells) {
    if (cell.type !== "artifact" || cell.initializer === void 0)
      continue;
    emitExpressionReads(cell.initializer, cell.loc, onRead);
    onWrite(cell.name, cell.loc);
  }
  for (const list of [
    node2.statements,
    node2.trigger,
    node2.guard,
    node2.deflectWhen,
    node2.catchDeflection,
    node2.catchInterruption,
    node2.effects
  ]) {
    collectReadsAndWrites(list ?? [], onRead, onWrite);
  }
  if (node2.guidance)
    emitSemanticReads(node2.guidance, node2.loc, onRead);
  for (const cell of node2.cells) {
    const observing = isScalarObservableCell(cell) ? cell.observing : isArrayCell(cell) && cell.element.type !== "artifact" ? cell.element.observing : void 0;
    if (observing) {
      emitSemanticReads(observing, cell.loc, onRead);
    }
  }
  for (const child of node2.children) {
    collectArcCellUsage(child, declarations, firstRead, assigned);
  }
}
function lintNodeReadBeforeSet(node2, lintIssues) {
  const local = new Set(node2.cells.filter(isValueExpressionCell).map((cell) => cell.name));
  if (local.size === 0)
    return;
  const qualifying = /* @__PURE__ */ new Set();
  const noteAssignment = (name2) => {
    if (local.has(name2))
      qualifying.add(name2);
  };
  const ignore = () => {
  };
  collectReadsAndWrites(node2.statements, ignore, noteAssignment);
  collectReadsAndWrites(node2.trigger ?? [], ignore, noteAssignment);
  for (const cell of node2.cells) {
    if (cell.type === "artifact" && cell.initializer !== void 0) {
      qualifying.add(cell.name);
    }
  }
  if (qualifying.size === 0)
    return;
  const childrenById = new Map(node2.children.map((child) => [child.identifier, child]));
  const assigned = /* @__PURE__ */ new Set();
  const reported = /* @__PURE__ */ new Set();
  walkReadBeforeSet(node2.trigger ?? [], assigned, qualifying, childrenById, reported, void 0);
  for (const cell of node2.cells) {
    if (cell.type !== "artifact" || cell.initializer === void 0)
      continue;
    const reads = /* @__PURE__ */ new Set();
    collectExpressionReads(cell.initializer, reads);
    for (const name2 of reads) {
      if (qualifying.has(name2) && !assigned.has(name2) && !reported.has(name2)) {
        reported.add(name2);
        emitLintIssue(lintIssues, "read-before-assignment", cell.loc);
      }
    }
    assigned.add(cell.name);
  }
  walkReadBeforeSet(node2.statements, assigned, qualifying, childrenById, reported, lintIssues);
}
function walkReadBeforeSet(statements, assigned, qualifying, childrenById, reported, lintIssues) {
  const report = (name2, loc) => {
    if (!lintIssues)
      return;
    if (qualifying.has(name2) && !assigned.has(name2) && !reported.has(name2)) {
      reported.add(name2);
      emitLintIssue(lintIssues, "read-before-assignment", loc);
    }
  };
  const reportExpression = (expression, loc) => {
    const reads = /* @__PURE__ */ new Set();
    collectExpressionReads(expression, reads);
    for (const name2 of reads)
      report(name2, loc);
  };
  const reportSemantic = (value, loc) => {
    const reads = /* @__PURE__ */ new Set();
    collectSemanticStringReads(value, reads);
    for (const name2 of reads)
      report(name2, loc);
  };
  for (const statement2 of statements) {
    switch (statement2.kind) {
      case "if": {
        reportExpression(statement2.test, statement2.loc);
        const consequent = new Set(assigned);
        walkReadBeforeSet(statement2.consequent, consequent, qualifying, childrenById, reported, lintIssues);
        const alternate = new Set(assigned);
        walkReadBeforeSet(statement2.alternate ?? [], alternate, qualifying, childrenById, reported, lintIssues);
        for (const name2 of consequent) {
          if (alternate.has(name2))
            assigned.add(name2);
        }
        break;
      }
      case "label":
        walkReadBeforeSet(statement2.body, assigned, qualifying, childrenById, reported, lintIssues);
        break;
      case "set":
        emitCellTargetReads(statement2.target, statement2.loc, report);
        reportExpression(statement2.value, statement2.loc);
        if (isDirectCellTarget(statement2.target)) {
          assigned.add(cellTargetRoot(statement2.target));
        }
        break;
      case "unset":
        assigned.delete(cellTargetRoot(statement2.target));
        break;
      case "observe":
      case "observeOrAsk":
        emitCellTargetReads(statement2.target, statement2.loc, report);
        if (statement2.question)
          reportSemantic(statement2.question, statement2.loc);
        if (isDirectCellTarget(statement2.target)) {
          assigned.add(cellTargetRoot(statement2.target));
        }
        break;
      case "observeGroup":
      case "observeOrAskGroup":
        for (const target2 of statement2.targets) {
          emitCellTargetReads(target2, statement2.loc, report);
          if (isDirectCellTarget(target2)) {
            assigned.add(cellTargetRoot(target2));
          }
        }
        break;
      case "map": {
        if (statement2.receiver.kind === "cell") {
          report(statement2.receiver.name, statement2.loc);
        }
        walkReadBeforeSet(statement2.body, new Set(assigned), qualifying, childrenById, reported, lintIssues);
        if (statement2.results)
          assigned.add(statement2.results);
        break;
      }
      case "set-span":
      case "set-return":
        reportExpression(statement2.value, statement2.loc);
        break;
      case "return":
        if (statement2.value)
          reportExpression(statement2.value, statement2.loc);
        break;
      case "enter-node":
        if (statement2.args) {
          for (const source of Object.values(statement2.args)) {
            if (source.kind === "cell")
              report(source.cell, statement2.loc);
          }
        }
        if (statement2.returns) {
          for (const source of Object.values(statement2.returns)) {
            if (source.kind === "cell")
              assigned.add(source.cell);
          }
        }
        break;
      case "invoke":
        walkReadBeforeSet(statement2.body, assigned, qualifying, childrenById, reported, lintIssues);
        break;
      case "enter-loop":
        if (statement2.args) {
          for (const source of Object.values(statement2.args)) {
            if (source.kind === "cell")
              report(source.cell, statement2.loc);
          }
        }
        if (statement2.returns) {
          for (const source of Object.values(statement2.returns)) {
            if (source.kind === "cell")
              assigned.add(source.cell);
          }
        }
        break;
      case "instruction":
        reportSemantic(statement2.template, statement2.loc);
        break;
      default:
        break;
    }
  }
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/parser/index.js
var HOST_MODULE_SOURCE_PREFIX = "host:";
var ARC_RESERVED_IMPORT_ALIAS_NAMES = /* @__PURE__ */ new Set([
  "$enter",
  "$enterLoop",
  "$instruct",
  "$instructLoop",
  "$observe",
  "$observeOrAsk",
  "Array",
  "Artifact",
  "Bool",
  "Dialog",
  "Enum",
  "Index",
  "Num",
  "RangedInt",
  "State",
  "Str",
  "args",
  "forgetful",
  "invoke",
  "judge",
  "newcopy",
  "returns",
  "self",
  "span",
  "user"
]);
function parse4(source) {
  const program = parse3(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true
  });
  assertFiniteNumericLiterals(program);
  if (!hasArcDirective(program.body)) {
    throw new Error('Expected "arc" directive');
  }
  const imports = [];
  const hostModules = [];
  for (const statement2 of program.body) {
    if (statement2.type !== "ImportDeclaration")
      continue;
    const source2 = String(statement2.source.value);
    const isHostModuleImport = source2.startsWith(HOST_MODULE_SOURCE_PREFIX);
    for (const specifier of statement2.specifiers) {
      assertImportAliasAvailable(specifier.local.name);
      if (specifier.type === "ImportDefaultSpecifier") {
        if (isHostModuleImport) {
          hostModules.push({
            module: parseHostModuleName(source2),
            importedName: "default",
            localName: specifier.local.name,
            source: source2,
            loc: locOf(specifier)
          });
          continue;
        }
        throw new Error("Arc does not support default imports; import roots by named binding");
      }
      if (isHostModuleImport) {
        throw new Error("Arc host module imports must use a default import binding");
      }
      if (specifier.type === "ImportSpecifier") {
        const importedName = specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value);
        imports.push({
          importedName,
          localName: specifier.local.name,
          source: source2,
          loc: locOf(specifier)
        });
      }
    }
  }
  const rootFunctions = [];
  const rootNames = /* @__PURE__ */ new Set();
  for (const statement2 of program.body) {
    if (statement2 === program.body[0] || statement2.type === "ImportDeclaration") {
      continue;
    }
    if (statement2.type === "FunctionDeclaration") {
      if (!statement2.id?.name) {
        throw new Error("Root node declarations must be named");
      }
      if (rootNames.has(statement2.id.name)) {
        throw new Error(`Duplicate arc: ${statement2.id.name}`);
      }
      rootNames.add(statement2.id.name);
      rootFunctions.push(statement2);
      continue;
    }
    if (statement2.type === "ExportNamedDeclaration" || statement2.type === "ExportDefaultDeclaration" || statement2.type === "ExportAllDeclaration") {
      throw new Error("Export syntax is not supported; declare the root node directly");
    }
    if (statement2.type === "VariableDeclaration") {
      throw new Error("Document-level cell declarations are not allowed; declare cells directly in a root node body");
    }
    throw new Error("Only imports and root node declarations are allowed at document level");
  }
  if (rootFunctions.length === 0) {
    throw new Error("No root node declarations found");
  }
  const roots = rootFunctions.map((fn) => parseNode(fn, new Set(imports.map((entry) => entry.localName)), new Map(hostModules.map((entry) => [entry.localName, entry.module])), /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set(), void 0));
  const document = {
    imports,
    hostModules,
    roots
  };
  const structuralIssues = [];
  validateDocumentStructure(document, structuralIssues);
  if (structuralIssues.length > 0) {
    const first = structuralIssues[0];
    throw new Error(`${first.code}: ${first.message}`);
  }
  for (const root of roots)
    stampElementIds(root);
  const issues = validate(document);
  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(first ? `${first.code}: ${first.message}` : "Arc validation failed");
  }
  return document;
}
function assertFiniteNumericLiterals(program) {
  const seen = /* @__PURE__ */ new WeakSet();
  const visit = (value) => {
    if (value === null || typeof value !== "object")
      return;
    if (seen.has(value))
      return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value)
        visit(item);
      return;
    }
    const node2 = value;
    if (node2.type === "Literal" && typeof node2.value === "number" && !Number.isFinite(node2.value)) {
      const error = new Error("Numeric literal must be finite");
      error.code = "NON_FINITE_NUMBER";
      error.loc = locOf(value);
      throw error;
    }
    for (const item of Object.values(value)) {
      visit(item);
    }
  };
  visit(program);
}
function validate(document) {
  return analyzeDocument(document).issues;
}
function analyzeDocument(document, options = {}) {
  const issues = [];
  const lintIssues = [];
  const bySeg = /* @__PURE__ */ new Map();
  activeReadSet = void 0;
  activeInvokeBuilders = [];
  mapContextStack = [];
  activeSegReadSets = void 0;
  validateDocumentStructure(document, issues);
  if (issues.length > 0) {
    return { issues, lintIssues, rewalkPlan: { bySeg } };
  }
  validatePublicImportBindings(document, issues);
  if (issues.length > 0) {
    return { issues, lintIssues, rewalkPlan: { bySeg } };
  }
  if (options.hostModules !== void 0) {
    validateDeclaredHostModules(document, options.hostModules, issues);
    if (issues.length > 0) {
      return { issues, lintIssues, rewalkPlan: { bySeg } };
    }
  }
  validateDocumentShape(document, issues);
  const documentImportNames = new Set(document.imports.map((entry) => entry.localName));
  for (const root of document.roots) {
    verifyElementIds(root, issues);
    lintRootArc(root, lintIssues);
    lintArcCellReads(root, lintIssues);
    validateNode(root, {
      issues,
      lintIssues,
      cells: [],
      visibleLocalNodes: /* @__PURE__ */ new Set(),
      visibleImportNames: /* @__PURE__ */ new Set(),
      documentImportNames,
      nodeLookup: new Map(root.children.map((child) => [child.identifier, child])),
      bySeg,
      hostModules: options.hostModules
    });
  }
  return { issues, lintIssues, rewalkPlan: { bySeg } };
}
var activeReadSet;
var activeInvokeBuilders = [];
var mapContextStack = [];
var activeSegReadSets;
function recordCellRead(name2) {
  activeReadSet?.cells.add(name2);
  for (const builder of activeInvokeBuilders)
    builder.cells.add(name2);
}
function recordNodeStateRead(identifier) {
  activeReadSet?.nodeIdentifiers.add(identifier);
  for (const builder of activeInvokeBuilders) {
    builder.nodeIdentifiers.add(identifier);
  }
}
function recordChannelRead(namespace, key) {
  activeReadSet?.channels.set(`${namespace}.${key}`, { namespace, key });
  for (const builder of activeInvokeBuilders) {
    builder.channels.set(`${namespace}.${key}`, { namespace, key });
  }
}
function finalizeReadSet(builder) {
  return {
    cells: [...builder.cells],
    nodeIdentifiers: [...builder.nodeIdentifiers],
    channels: [...builder.channels.values()]
  };
}
function hasArcDirective(body2) {
  const first = body2[0];
  if (!first || first.type !== "ExpressionStatement")
    return false;
  const expression = first.expression;
  if (expression.type !== "Literal" || typeof expression.value !== "string") {
    return false;
  }
  return expression.value === "arc";
}
function parseHostModuleName(source) {
  const module = source.slice(HOST_MODULE_SOURCE_PREFIX.length);
  if (!module) {
    throw new Error("Host module import source must include a module name");
  }
  return module;
}
function assertImportAliasAvailable(localName) {
  if (ARC_RESERVED_IMPORT_ALIAS_NAMES.has(localName)) {
    throw new Error(`Import alias ${JSON.stringify(localName)} is reserved by Arc`);
  }
}
function validatePublicImportBindings(document, issues) {
  for (const binding2 of [...document.hostModules, ...document.imports]) {
    if (!ARC_RESERVED_IMPORT_ALIAS_NAMES.has(binding2.localName))
      continue;
    issues.push({
      code: "RESERVED_IMPORT_ALIAS",
      message: `Import alias ${JSON.stringify(binding2.localName)} is reserved by Arc`,
      loc: binding2.loc
    });
  }
}
function validateDeclaredHostModules(document, hostModules, issues) {
  for (const binding2 of document.hostModules) {
    if (hostModules.has(binding2.module))
      continue;
    issues.push({
      code: "HOST_MODULE_UNDECLARED",
      message: `Host module ${JSON.stringify(binding2.module)} has no injected declaration`,
      loc: binding2.loc
    });
  }
}
function parseNode(fn, availableImports, availableHostModules, visibleNodeNames, visibleCellNames, inheritedDeflectWhen) {
  if (!fn.id?.name) {
    throw new Error("Node declarations must be named");
  }
  if (fn.id.name === "invoke") {
    throw new Error("invoke is a reserved name and cannot name a node");
  }
  const signature2 = parseNodeSignature(fn.params);
  const cells = [];
  const childFunctions = /* @__PURE__ */ new Map();
  let forgetfulEntry = false;
  const writeDiffMode = "advance";
  let displayName;
  let description;
  let guidance;
  let hostParams;
  let trigger;
  let deflectWhen;
  let catchDeflection;
  let catchDeflectionBody;
  let catchInterruption;
  let catchInterruptionBody;
  let guard;
  let effects;
  let effectsBody;
  const seenNodeConfigAssignments = /* @__PURE__ */ new Set();
  const handledStatements = /* @__PURE__ */ new Set();
  for (const statement2 of fn.body.body) {
    if (statement2.type === "VariableDeclaration") {
      const parsedCells = parseCellDeclarations(statement2, availableHostModules);
      if (parsedCells.length !== statement2.declarations.length) {
        throw new Error("Node-body declarations must use supported Arc cell constructors");
      }
      cells.push(...parsedCells);
      handledStatements.add(statement2);
      continue;
    }
    if (statement2.type === "FunctionDeclaration" && statement2.id) {
      childFunctions.set(statement2.id.name, statement2);
      handledStatements.add(statement2);
      continue;
    }
    if (statement2.type !== "ExpressionStatement")
      continue;
    const expression = statement2.expression;
    if (expression.type !== "AssignmentExpression" || expression.operator !== "=") {
      continue;
    }
    const thisProperty = getThisProperty(expression.left);
    if (thisProperty === "observing") {
      throw new Error("this.observing is not supported in Arc; use cell.observing for extraction guidance or this.guidance for node guidance");
    }
    if (thisProperty === "displayName" || thisProperty === "description" || thisProperty === "guidance" || thisProperty === "hostParams" || thisProperty === "forgetfulEntry" || thisProperty === "trigger" || thisProperty === "deflectWhen" || thisProperty === "catchDeflection" || thisProperty === "catchInterruption" || thisProperty === "guard" || thisProperty === "effects") {
      if (seenNodeConfigAssignments.has(thisProperty)) {
        throw new Error(`Duplicate node config assignment: this.${thisProperty}`);
      }
      seenNodeConfigAssignments.add(thisProperty);
    }
    if (thisProperty === "displayName") {
      if (expression.right.type !== "Literal" || typeof expression.right.value !== "string") {
        throw new Error("this.displayName must be a string literal");
      }
      displayName = expression.right.value;
      handledStatements.add(statement2);
      continue;
    }
    if (thisProperty === "description") {
      if (expression.right.type !== "Literal" || typeof expression.right.value !== "string") {
        throw new Error("this.description must be a string literal");
      }
      description = expression.right.value;
      handledStatements.add(statement2);
      continue;
    }
    if (thisProperty === "guidance") {
      guidance = parseSemanticString(expression.right, availableHostModules);
      handledStatements.add(statement2);
      continue;
    }
    if (thisProperty === "hostParams") {
      hostParams = parseHostParamsValue(expression.right, "this.hostParams");
      handledStatements.add(statement2);
      continue;
    }
    if (thisProperty === "forgetfulEntry") {
      if (expression.right.type !== "Literal" || typeof expression.right.value !== "boolean") {
        throw new Error("this.forgetfulEntry must be a boolean literal");
      }
      forgetfulEntry = expression.right.value;
      handledStatements.add(statement2);
      continue;
    }
    if (thisProperty === "trigger") {
      trigger = parseTriggerArrowFunction(expression.right, "this.trigger", availableHostModules);
      handledStatements.add(statement2);
      continue;
    }
    if (thisProperty === "deflectWhen") {
      deflectWhen = parseResolutionDefinition(expression.right, "this.deflectWhen", availableHostModules);
      handledStatements.add(statement2);
      continue;
    }
    if (thisProperty === "catchInterruption") {
      if (expression.right.type !== "ArrowFunctionExpression") {
        throw new Error("this.catchInterruption must be an arrow function");
      }
      if (expression.right.async || expression.right.params.length > 0) {
        throw new Error("this.catchInterruption must be a synchronous arrow function without parameters");
      }
      catchInterruptionBody = getHookBodyStatements(expression.right, "return") ?? void 0;
      handledStatements.add(statement2);
      continue;
    }
    if (thisProperty === "catchDeflection") {
      if (expression.right.type !== "ArrowFunctionExpression") {
        throw new Error("this.catchDeflection must be an arrow function");
      }
      const body2 = getHookBodyStatements(expression.right, "return");
      if (!body2)
        throw new Error("this.catchDeflection must be a function");
      catchDeflectionBody = body2;
      handledStatements.add(statement2);
      continue;
    }
    if (thisProperty === "guard") {
      if (expression.right.type !== "ArrowFunctionExpression") {
        throw new Error("this.guard must be an arrow function");
      }
      const body2 = getHookBodyStatements(expression.right, "return");
      if (!body2)
        throw new Error("this.guard must be a function");
      guard = parseGuardStatements(body2, availableHostModules);
      handledStatements.add(statement2);
      continue;
    }
    if (thisProperty === "effects") {
      if (expression.right.type !== "ArrowFunctionExpression") {
        throw new Error("this.effects must be an arrow function");
      }
      const body2 = getHookBodyStatements(expression.right, "expression");
      if (!body2)
        throw new Error("this.effects must be a function");
      effectsBody = body2;
      handledStatements.add(statement2);
      continue;
    }
    const member = getMemberTarget(expression.left);
    if (member?.property === "observing") {
      const cell = cells.find((entry) => entry.name === member.object);
      if (!cell) {
        throw new Error(`Unknown cell for observing assignment: ${member.object}`);
      }
      if (!isScalarObservableCell(cell)) {
        throw new Error(`${member.object}.observing is only supported for scalar observable cells`);
      }
      if (cell.observing !== void 0) {
        throw new Error(`Duplicate cell config assignment: ${member.object}.observing`);
      }
      cell.observing = parseSemanticString(expression.right, availableHostModules);
      handledStatements.add(statement2);
    }
  }
  const effectiveDeflectWhen = deflectWhen ?? inheritedDeflectWhen;
  const nextVisibleNodeNames = /* @__PURE__ */ new Set([
    ...visibleNodeNames,
    ...childFunctions.keys()
  ]);
  const nextVisibleCellNames = /* @__PURE__ */ new Set([
    ...visibleCellNames,
    ...cells.map((entry) => entry.name)
  ]);
  const enclosing = {
    identifier: fn.id.name,
    childNames: new Set(childFunctions.keys())
  };
  if (catchInterruptionBody) {
    catchInterruption = parseCatchStatements(catchInterruptionBody, availableHostModules, availableImports, nextVisibleNodeNames, enclosing, "catchInterruption");
  }
  if (catchDeflectionBody) {
    catchDeflection = parseCatchStatements(catchDeflectionBody, availableHostModules, availableImports, nextVisibleNodeNames, enclosing);
  }
  if (effectsBody) {
    effects = parseEffectStatements(effectsBody, availableHostModules, {
      allowPendingState: true,
      deflectionTargets: {
        availableImports,
        visibleNodeNames: nextVisibleNodeNames,
        enclosing
      }
    });
  }
  const childFunctionNodes = [...childFunctions.values()].map((child) => parseNode(child, availableImports, availableHostModules, nextVisibleNodeNames, nextVisibleCellNames, effectiveDeflectWhen));
  const statements = fn.body.body.flatMap((statement2) => parseNodeStatement(statement2, childFunctions, handledStatements, availableImports, nextVisibleNodeNames, nextVisibleCellNames, availableHostModules, effectiveDeflectWhen, enclosing));
  const children = [...childFunctionNodes];
  return {
    identifier: fn.id.name,
    displayName,
    description,
    guidance,
    hostParams,
    forgetfulEntry,
    writeDiffMode,
    signature: signature2,
    cells,
    statements,
    children,
    // Rebuilt by stampElementIds once ids are stamped; aliases embed ids.
    newcopyAliases: [],
    imports: [...availableImports],
    trigger,
    deflectWhen,
    catchDeflection,
    catchInterruption,
    guard,
    effects,
    loc: locOf(fn)
  };
}
function parseNodeSignature(params) {
  if (params.length === 0)
    return void 0;
  let args;
  let returns;
  for (const param of params) {
    if (param.type !== "AssignmentPattern" || param.left.type !== "Identifier") {
      throw new Error("Node parameters must be `args = { \u2026 }` and/or `returns = { \u2026 }` with object-literal channel schemas");
    }
    const name2 = param.left.name;
    if (name2 !== "args" && name2 !== "returns") {
      throw new Error(`Unsupported node parameter: ${name2}`);
    }
    if (param.right.type !== "ObjectExpression") {
      throw new Error(`Node ${name2} must default to an object-literal schema`);
    }
    if (name2 === "args") {
      if (args)
        throw new Error("Duplicate node parameter: args");
      if (returns)
        throw new Error("Node args must precede returns");
      args = parseChannelSchema(param.right, "args");
    } else {
      if (returns)
        throw new Error("Duplicate node parameter: returns");
      returns = parseChannelSchema(param.right, "returns");
    }
  }
  return { args: args ?? {}, returns: returns ?? {} };
}
function parseChannelSchema(object, namespace) {
  const schema = {};
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(`${namespace} schema does not support spread`);
    }
    if (property.computed || property.key.type !== "Identifier") {
      throw new Error(`${namespace} schema keys must be plain identifiers`);
    }
    const key = property.key.name;
    if (schema[key]) {
      throw new Error(`${namespace} schema has duplicate key: ${key}`);
    }
    if (isReservedChannelKey(key)) {
      throw new Error(`${namespace} schema key "${key}" is reserved and cannot name a channel`);
    }
    schema[key] = parseChannelSpec(property.value, `${namespace}.${key}`);
  }
  return schema;
}
function parseChannelSpec(expression, owner) {
  if (expression.type !== "CallExpression") {
    throw new Error(`${owner} must be a channel spec constructor`);
  }
  const callee = expression.callee;
  if (callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" && callee.object.name === "Dialog" && callee.property.type === "Identifier") {
    if (callee.property.name !== "Cursor") {
      throw new Error(`${owner} unsupported Dialog channel: ${callee.property.name}`);
    }
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Dialog.Cursor() takes no arguments`);
    }
    return { type: "dialogCursor" };
  }
  if (callee.type !== "Identifier") {
    throw new Error(`${owner} must be a channel spec constructor`);
  }
  const name2 = callee.name;
  if (name2 === "Artifact") {
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Artifact() channel spec takes no arguments`);
    }
    return { type: "artifact" };
  }
  if (name2 === "Index") {
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Index() takes no arguments`);
    }
    return { type: "index" };
  }
  if (name2 === "Bool") {
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Bool() channel spec takes no configuration`);
    }
    return { type: "boolean" };
  }
  if (name2 === "Str") {
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Str() channel spec takes no configuration`);
    }
    return { type: "string" };
  }
  if (name2 === "Num") {
    if (expression.arguments.length !== 0) {
      throw new Error(`${owner} Num() channel spec takes no configuration`);
    }
    return { type: "number" };
  }
  if (name2 === "Enum") {
    const arg = expression.arguments[0];
    if (expression.arguments.length !== 1 || !arg || arg.type !== "ArrayExpression") {
      throw new Error(`${owner} Enum() channel spec requires a single array literal`);
    }
    const values = arg.elements.map((element) => {
      if (!element || element.type !== "Literal" || typeof element.value !== "string") {
        throw new Error(`${owner} Enum() channel spec requires string values`);
      }
      return element.value;
    });
    return { type: "enum", values };
  }
  if (name2 === "RangedInt") {
    throw new Error(`${owner} RangedInt() is observation shorthand and cannot declare a channel; use Num()`);
  }
  if (name2 === "Array") {
    const arg = expression.arguments[0];
    if (expression.arguments.length !== 1 || !arg || arg.type === "SpreadElement") {
      throw new Error(`${owner} Array() channel spec takes one element constructor`);
    }
    const element = parseChannelSpec(arg, `${owner} element`);
    if (element.type === "array") {
      throw new Error(`${owner} Array() channel spec cannot nest arrays`);
    }
    if (element.type === "index" || element.type === "dialogCursor") {
      throw new Error(`${owner} Array() element must be a scalar or Artifact channel type`);
    }
    return { type: "array", element };
  }
  throw new Error(`${owner} unsupported channel spec: ${name2}`);
}
function collectNewCopyNodeAliases(statements) {
  const aliases = [];
  const visit = (statement2) => {
    if (statement2.kind === "if") {
      statement2.consequent.forEach(visit);
      statement2.alternate?.forEach(visit);
      return;
    }
    if (statement2.kind === "label") {
      statement2.body.forEach(visit);
      return;
    }
    if (statement2.kind === "invoke" || statement2.kind === "map") {
      statement2.body.forEach(visit);
      return;
    }
    if ((statement2.kind === "enter-node" || statement2.kind === "enter-loop") && statement2.target.mode === "newcopy") {
      aliases.push({
        identifier: `${statement2.target.identifier}#${statement2.id}`,
        target: statement2.target.identifier,
        imported: statement2.target.imported
      });
    }
  };
  statements.forEach(visit);
  return aliases;
}
function stampElementIds(node2) {
  applyElementIds(node2, void 0);
}
function verifyElementIds(node2, issues) {
  applyElementIds(node2, issues);
}
function applyElementIds(node2, verify) {
  const scopes = [
    [node2.trigger, "trigger/"],
    [node2.deflectWhen, "deflectWhen/"],
    [node2.guard, "guard/"],
    [node2.catchDeflection, "catch/"],
    [node2.catchInterruption, "catchInterruption/"],
    [node2.effects, "effects/"],
    [node2.statements, "body/"]
  ];
  for (const [list, prefix] of scopes) {
    if (list)
      applyStatementIds(list, prefix, verify);
  }
  if (verify) {
    verifyNewcopyAliases(node2, verify);
  } else {
    node2.newcopyAliases = collectNewCopyNodeAliases(node2.statements);
  }
  for (const child of node2.children)
    applyElementIds(child, verify);
}
function verifyNewcopyAliases(node2, issues) {
  const expected = collectNewCopyNodeAliases(node2.statements);
  const actual = node2.newcopyAliases;
  const matches = actual.length === expected.length && expected.every((alias, index) => {
    const found = actual[index];
    return found !== void 0 && found.identifier === alias.identifier && found.target === alias.target && found.imported === alias.imported;
  });
  if (!matches) {
    issues.push({
      code: "ELEMENT_ID",
      message: `Derived newcopyAliases on node "${node2.identifier}" do not match the document shape; normalize with stampElementIds`,
      loc: node2.loc
    });
  }
}
function applyStatementIds(list, prefix, verify) {
  list.forEach((statement2, index) => {
    const id2 = `${prefix}${index}`;
    applyElementId(statement2, id2, verify);
    let expressionCount = 0;
    const nextExpressionId = () => `${id2}~${expressionCount++}`;
    switch (statement2.kind) {
      case "if":
        applyExpressionIds(statement2.test, nextExpressionId, verify);
        applyStatementIds(statement2.consequent, `${id2}c/`, verify);
        if (statement2.alternate) {
          applyStatementIds(statement2.alternate, `${id2}a/`, verify);
        }
        return;
      case "label":
        applyStatementIds(statement2.body, `${id2}l/`, verify);
        return;
      case "return":
        if (statement2.value) {
          applyExpressionIds(statement2.value, nextExpressionId, verify);
        }
        return;
      case "set":
      case "set-return":
      case "set-span":
        applyExpressionIds(statement2.value, nextExpressionId, verify);
        return;
      case "invoke":
        applyStatementIds(statement2.body, `${id2}/`, verify);
        return;
      case "map":
        applyStatementIds(statement2.body, `${id2}/`, verify);
        return;
      case "enter-loop":
        applyStatementIds(statement2.resolveWhen, `${id2}/resolveWhen/`, verify);
        return;
      case "instruction":
        if (statement2.resolveWhen) {
          applyStatementIds(statement2.resolveWhen, `${id2}/resolveWhen/`, verify);
        }
        if (statement2.deflectWhen) {
          applyStatementIds(statement2.deflectWhen, statement2.inheritedDeflectWhen ? "deflectWhen/" : `${id2}/deflectWhen/`, verify);
        }
        return;
      case "host-call":
        for (const argument of statement2.arguments) {
          applyArgumentIds(argument, nextExpressionId, verify);
        }
        return;
      default:
        return;
    }
  });
}
function applyExpressionIds(expression, nextExpressionId, verify) {
  switch (expression.kind) {
    case "judge":
      applyElementId(expression, nextExpressionId(), verify);
      return;
    case "host-call":
      applyElementId(expression, nextExpressionId(), verify);
      for (const argument of expression.arguments) {
        applyArgumentIds(argument, nextExpressionId, verify);
      }
      return;
    case "regexTest":
      applyExpressionIds(expression.target, nextExpressionId, verify);
      return;
    case "comparison":
    case "arithmetic":
    case "logical":
      applyExpressionIds(expression.left, nextExpressionId, verify);
      applyExpressionIds(expression.right, nextExpressionId, verify);
      return;
    case "conditional":
      applyExpressionIds(expression.test, nextExpressionId, verify);
      applyExpressionIds(expression.consequent, nextExpressionId, verify);
      applyExpressionIds(expression.alternate, nextExpressionId, verify);
      return;
    case "unary":
    case "numericUnary":
    case "numIsFinite":
      applyExpressionIds(expression.argument, nextExpressionId, verify);
      return;
    case "template-string":
      for (const part of expression.parts) {
        if (part.kind === "expression") {
          applyExpressionIds(part.expression, nextExpressionId, verify);
        }
      }
      return;
    case "artifact":
      applyExpressionIds(expression.path, nextExpressionId, verify);
      return;
    case "arrayElementRead":
      applyExpressionIds(expression.index, nextExpressionId, verify);
      return;
    case "arrayLiteral":
      for (const element of expression.elements) {
        applyExpressionIds(element, nextExpressionId, verify);
      }
      return;
    default:
      return;
  }
}
function applyArgumentIds(argument, nextExpressionId, verify) {
  switch (argument.kind) {
    case "semantic":
      return;
    case "value":
      applyExpressionIds(argument.value, nextExpressionId, verify);
      return;
    case "array":
      for (const entry of argument.elements) {
        applyArgumentIds(entry, nextExpressionId, verify);
      }
      return;
    case "object":
      for (const key of Object.keys(argument.value)) {
        const entry = argument.value[key];
        if (entry)
          applyArgumentIds(entry, nextExpressionId, verify);
      }
      return;
  }
}
function applyElementId(element, expected, verify) {
  if (!verify) {
    element.id = expected;
    return;
  }
  if (element.id !== expected) {
    verify.push({
      code: "ELEMENT_ID",
      message: `Element id ${element.id === UNSTAMPED_ID ? "(unstamped)" : `"${element.id}"`} does not match its structural id "${expected}"; normalize the document with stampElementIds`,
      loc: element.loc
    });
  }
}
function parseCellDeclarations(statement2, availableHostModules) {
  const cells = [];
  for (const declaration of statement2.declarations) {
    const id2 = declaration.id;
    if (declaration.init?.type === "NewExpression") {
      throw new Error("Arc cell declarations do not support new; use Type(...) instead");
    }
    if (!declaration.init || declaration.init.type !== "CallExpression" || id2.type !== "Identifier") {
      continue;
    }
    if (id2.name === "invoke") {
      throw new Error("invoke is a reserved name and cannot name a cell");
    }
    const callee = declaration.init.callee;
    if (callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier" && callee.object.name === "Dialog" && callee.property.type === "Identifier") {
      if (callee.property.name !== "Cursor") {
        throw new Error(`Unsupported Dialog cell type: ${callee.property.name}`);
      }
      if (declaration.init.arguments.length !== 0) {
        throw new Error(`Dialog.Cursor cell ${id2.name} accepts no arguments`);
      }
      cells.push({
        name: id2.name,
        type: "dialogCursor",
        loc: locOf(id2)
      });
      continue;
    }
    if (callee.type !== "Identifier")
      continue;
    if (callee.name === "Artifact") {
      if (declaration.init.arguments.length === 0) {
        cells.push({
          name: id2.name,
          type: "artifact",
          loc: locOf(id2)
        });
        continue;
      }
      const initializer = parseArtifactConstructCall(declaration.init, `Artifact ${id2.name}`, availableHostModules, true);
      if (containsBriefableExpression(initializer)) {
        throw new Error(`Artifact ${id2.name} path cannot contain judge() or host call expressions`);
      }
      cells.push({
        name: id2.name,
        type: "artifact",
        initializer,
        loc: locOf(id2)
      });
      continue;
    }
    if (callee.name === "Index") {
      throw new Error(`Index() is a channel-only type and cannot declare the cell ${id2.name}`);
    }
    if (callee.name === "Array") {
      const element = parseArrayElementSpec(id2.name, declaration.init.arguments, availableHostModules);
      if (element.type === "artifact") {
        cells.push({
          name: id2.name,
          type: "array",
          element: { type: "artifact" },
          loc: locOf(id2)
        });
      } else {
        cells.push({
          name: id2.name,
          type: "array",
          element,
          loc: locOf(id2)
        });
      }
      continue;
    }
    const scalar = parseScalarConstructorSpec(declaration.init, id2.name, availableHostModules);
    if (scalar) {
      cells.push({ name: id2.name, ...scalar, loc: locOf(id2) });
    }
  }
  return cells;
}
function parseScalarConstructorSpec(call, owner, availableHostModules) {
  if (call.callee.type !== "Identifier")
    return void 0;
  const name2 = call.callee.name;
  if (name2 === "Enum") {
    const arg = call.arguments[0];
    const config = parseCellConfig(owner, name2, call.arguments[1], availableHostModules);
    if (!arg || arg.type === "SpreadElement" || arg.type !== "ArrayExpression") {
      throw new Error(`Enum cell ${owner} requires an array literal`);
    }
    const values = arg.elements.map((element) => {
      if (!element || element.type !== "Literal" || typeof element.value !== "string") {
        throw new Error(`Enum cell ${owner} requires string values`);
      }
      return element.value;
    });
    return { type: "enum", values, ...config };
  }
  if (name2 === "Bool") {
    const config = parseCellConfig(owner, name2, call.arguments[0], availableHostModules);
    return { type: "boolean", ...config };
  }
  if (name2 === "Str") {
    const config = parseCellConfig(owner, name2, call.arguments[0], availableHostModules);
    return { type: "string", ...config };
  }
  if (name2 === "Num") {
    const config = parseNumericCellConfig(owner, name2, call.arguments[0], availableHostModules);
    if (call.arguments.length > 1) {
      throw new Error(`Num cell ${owner} accepts at most one config argument`);
    }
    return { type: "number", ...config };
  }
  if (name2 === "RangedInt") {
    if (call.arguments.length > 3) {
      throw new Error(`RangedInt cell ${owner} accepts min, max, and an optional config argument`);
    }
    const minArg = call.arguments[0];
    const maxArg = call.arguments[1];
    const config = parseCellConfig(owner, name2, call.arguments[2], availableHostModules);
    const min = parseSignedNumericLiteral(minArg);
    const max = parseSignedNumericLiteral(maxArg);
    if (min === void 0 || max === void 0) {
      throw new Error(`RangedInt cell ${owner} requires numeric min/max literals`);
    }
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
      throw new Error(`RangedInt cell ${owner} requires ordered safe-integer min/max literals`);
    }
    return {
      type: "number",
      observeAs: { kind: "integer", min, max },
      ...config
    };
  }
  return void 0;
}
function parseArrayElementSpec(cellName, args, availableHostModules) {
  const arg = args[0];
  if (args.length !== 1 || !arg || arg.type === "SpreadElement") {
    throw new Error(`Array cell ${cellName} takes exactly one element constructor`);
  }
  if (arg.type !== "CallExpression") {
    throw new Error(`Array cell ${cellName} element must be a constructed scalar cell, e.g. Array(Str())`);
  }
  if (arg.callee.type === "Identifier" && arg.callee.name === "Array") {
    throw new Error(`Array cell ${cellName} cannot nest arrays`);
  }
  if (arg.callee.type === "Identifier" && arg.callee.name === "Artifact") {
    if (arg.arguments.length !== 0) {
      throw new Error(`Array cell ${cellName} Artifact() element takes no arguments`);
    }
    return { type: "artifact" };
  }
  const element = parseScalarConstructorSpec(arg, cellName, availableHostModules);
  if (!element) {
    throw new Error(`Array cell ${cellName} element must be a scalar or Artifact cell constructor`);
  }
  return element;
}
function parseCellConfig(cellName, typeName, arg, availableHostModules) {
  if (!arg)
    return {};
  if (arg.type === "SpreadElement" || arg.type !== "ObjectExpression") {
    throw new Error(`${typeName} cell ${cellName} config must be an object literal`);
  }
  const config = {};
  for (const property of arg.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(`${typeName} cell ${cellName} config does not support spread`);
    }
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : void 0;
    if (key !== "observing") {
      throw new Error(`${typeName} cell ${cellName} has unsupported config key: ${key ?? "<computed>"}`);
    }
    if (config.observing !== void 0) {
      throw new Error(`Duplicate cell config assignment: ${cellName}.observing`);
    }
    config.observing = parseSemanticString(property.value, availableHostModules);
  }
  return config;
}
function parseNumericCellConfig(cellName, typeName, arg, availableHostModules) {
  if (!arg)
    return {};
  if (arg.type === "SpreadElement" || arg.type !== "ObjectExpression") {
    throw new Error(`${typeName} cell ${cellName} config must be an object literal`);
  }
  const config = {};
  for (const property of arg.properties) {
    if (property.type === "SpreadElement" || property.computed) {
      throw new Error(`${typeName} cell ${cellName} config does not support spread or computed keys`);
    }
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : void 0;
    if (key === "observing") {
      if (config.observing !== void 0) {
        throw new Error(`Duplicate cell config assignment: ${cellName}.observing`);
      }
      config.observing = parseSemanticString(property.value, availableHostModules);
      continue;
    }
    if (key === "observeAs") {
      if (config.observeAs !== void 0) {
        throw new Error(`Duplicate cell config assignment: ${cellName}.observeAs`);
      }
      config.observeAs = parseNumericObserveAs(property.value, cellName);
      continue;
    }
    throw new Error(`${typeName} cell ${cellName} has unsupported config key: ${key ?? "<computed>"}`);
  }
  return config;
}
function parseNumericObserveAs(expression, cellName) {
  if (expression.type !== "ObjectExpression") {
    throw new Error(`Num cell ${cellName} observeAs must be an object literal`);
  }
  let kind;
  let min;
  let max;
  const seen = /* @__PURE__ */ new Set();
  for (const property of expression.properties) {
    if (property.type === "SpreadElement" || property.computed) {
      throw new Error(`Num cell ${cellName} observeAs does not support spread or computed keys`);
    }
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : void 0;
    if (key && seen.has(key)) {
      throw new Error(`Num cell ${cellName} observeAs repeats field: ${key}`);
    }
    if (key)
      seen.add(key);
    if (key === "kind") {
      if (property.value.type !== "Literal" || property.value.value !== "number" && property.value.value !== "integer") {
        throw new Error(`Num cell ${cellName} observeAs kind must be "number" or "integer"`);
      }
      kind = property.value.value;
      continue;
    }
    if (key === "min" || key === "max") {
      const value = parseSignedNumericLiteral(property.value);
      if (value === void 0) {
        throw new Error(`Num cell ${cellName} observeAs ${key} must be a numeric literal`);
      }
      if (key === "min")
        min = value;
      else
        max = value;
      continue;
    }
    throw new Error(`Num cell ${cellName} observeAs has unsupported field: ${key ?? "<computed>"}`);
  }
  if (!kind) {
    throw new Error(`Num cell ${cellName} observeAs requires kind`);
  }
  if (min !== void 0 && max !== void 0 && min > max) {
    throw new Error(`Num cell ${cellName} observeAs bounds must satisfy min <= max`);
  }
  if (kind === "integer" && (min !== void 0 && !Number.isSafeInteger(min) || max !== void 0 && !Number.isSafeInteger(max))) {
    throw new Error(`Num cell ${cellName} integer observeAs bounds must be safe integers`);
  }
  return {
    kind,
    ...min !== void 0 ? { min } : {},
    ...max !== void 0 ? { max } : {}
  };
}
function parseSignedNumericLiteral(expression) {
  if (!expression || expression.type === "SpreadElement")
    return void 0;
  if (expression.type === "Literal" && typeof expression.value === "number") {
    return Object.is(expression.value, -0) ? 0 : expression.value;
  }
  if (expression.type === "UnaryExpression" && expression.operator === "-" && expression.argument.type === "Literal" && typeof expression.argument.value === "number") {
    const value = -expression.argument.value;
    return Object.is(value, -0) ? 0 : value;
  }
  return void 0;
}
function parseNodeStatement(statement2, childFunctions, handledStatements, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing) {
  if (handledStatements.has(statement2)) {
    return [];
  }
  if (statement2.type === "LabeledStatement") {
    if (statement2.label.type !== "Identifier") {
      throw new Error("Arc labels must use identifier names");
    }
    if (statement2.body.type !== "BlockStatement") {
      throw new Error("Arc labels must target a block statement");
    }
    const parsed = {
      id: UNSTAMPED_ID,
      kind: "label",
      label: statement2.label.name,
      body: parseStatementList(statement2.body.body, childFunctions, handledStatements, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing),
      loc: locOf(statement2)
    };
    return [parsed];
  }
  if (statement2.type === "BreakStatement") {
    if (!statement2.label || statement2.label.type !== "Identifier") {
      throw new Error("Arc break statements must specify a label");
    }
    const parsed = {
      id: UNSTAMPED_ID,
      kind: "break",
      label: statement2.label.name,
      loc: locOf(statement2)
    };
    return [parsed];
  }
  if (statement2.type === "IfStatement") {
    const parsed = {
      id: UNSTAMPED_ID,
      kind: "if",
      test: parseExpression(statement2.test, availableHostModules, true),
      consequent: parseStatementList(getBlockStatements(statement2.consequent), childFunctions, handledStatements, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, void 0, enclosing),
      alternate: statement2.alternate ? parseStatementList(getBlockStatements(statement2.alternate), childFunctions, handledStatements, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, void 0, enclosing) : void 0,
      loc: locOf(statement2)
    };
    return [parsed];
  }
  if (statement2.type !== "ExpressionStatement") {
    throw unsupportedArcStatement("an Arc action graph", statement2);
  }
  const expression = statement2.expression;
  if (expression.type === "AssignmentExpression") {
    throw new Error("Unsupported Arc assignment; only this.* config and cell.observing assignments are allowed");
  }
  const action = parseActionExpression(expression, childFunctions, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing);
  if (!action) {
    throw new Error("Unsupported Arc expression statement");
  }
  return [action];
}
function unsupportedArcStatement(scope, statement2) {
  switch (statement2.type) {
    case "VariableDeclaration":
      return new Error("Cell declarations are only allowed directly in a node body");
    case "FunctionDeclaration":
      return new Error("Child node declarations are only allowed directly in a node body");
    case "ReturnStatement":
      return new Error(`\`return\` is not allowed in ${scope}`);
    case "WhileStatement":
      return new Error(`\`while\` is not supported in ${scope}`);
    case "DoWhileStatement":
      return new Error(`\`do...while\` is not supported in ${scope}`);
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
      return new Error(`\`for\` loops are not supported in ${scope}`);
    default:
      return new Error(`Unsupported statement in ${scope}`);
  }
}
function parseStatementList(statements, childFunctions, handledStatements, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing) {
  return statements.flatMap((statement2) => parseNodeStatement(statement2, childFunctions, handledStatements, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing));
}
function parseActionExpression(expression, childFunctions, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing) {
  if (expression.type === "CallExpression") {
    if (expression.callee.type === "ArrowFunctionExpression" || expression.callee.type === "FunctionExpression") {
      throw new Error("Statement-position IIFEs are not supported; use invoke(() => { ... })");
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "invoke") {
      return parseInvokeCall(expression, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing);
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "$observe") {
      return parseObserveCall(expression, "observe", availableHostModules);
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "$observeOrAsk") {
      return parseObserveCall(expression, "observeOrAsk", availableHostModules);
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "judge") {
      throw new Error("judge() must be used inside an expression");
    }
    if (expression.callee.type === "Identifier" && (expression.callee.name === "$instructLoop" || expression.callee.name === "$instruct")) {
      return parseInstructionCall(expression, availableHostModules, defaultDeflectWhen);
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "$enter") {
      return parseEnterCall(expression, availableImports, visibleNodeNames, visibleCellNames, enclosing);
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "$enterLoop") {
      return parseEnterLoopCall(expression, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, enclosing);
    }
    if (expression.callee.type === "MemberExpression" && !expression.callee.computed && expression.callee.property.type === "Identifier" && expression.callee.property.name === "$map") {
      return parseMapCall(expression, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing);
    }
    if (isSpanResultSetCallee(expression.callee)) {
      return parseSetSpanCall(expression, availableHostModules);
    }
    const mutation = parseCellMutationCall(expression, availableHostModules, "action");
    if (mutation)
      return mutation;
    const hostCall = parseStandaloneHostCall(expression, availableHostModules);
    if (hostCall)
      return hostCall;
  }
  return void 0;
}
function isSpanResultSetCallee(callee) {
  return callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" && callee.property.name === "$set" && callee.object.type === "MemberExpression" && !callee.object.computed && callee.object.object.type === "Identifier" && callee.object.object.name === "span" && callee.object.property.type === "Identifier" && callee.object.property.name === "result";
}
function parseSetSpanCall(expression, availableHostModules) {
  if (expression.arguments.length !== 1) {
    throw new Error("span.result.$set() takes exactly one value");
  }
  const argument = expression.arguments[0];
  if (!argument || argument.type === "SpreadElement") {
    throw new Error("span.result.$set() takes exactly one value");
  }
  return {
    id: UNSTAMPED_ID,
    kind: "set-span",
    owner: "map",
    value: parseExpression(argument, availableHostModules, true),
    loc: locOf(expression)
  };
}
function parseMapCall(expression, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing) {
  const callee = expression.callee;
  if (callee.type !== "MemberExpression" || callee.computed || callee.object.type === "Super") {
    throw new Error("$map must be called as receiver.$map(...)");
  }
  const receiver = mapReceiverFrom(callee.object, availableHostModules);
  if (!receiver) {
    throw new Error("$map receiver must be an array cell or a typed array channel");
  }
  const [arrow, resultsArg, ...rest] = expression.arguments;
  if (!arrow || rest.length > 0) {
    throw new Error("$map takes a callback and an optional results cell");
  }
  if (arrow.type === "FunctionExpression") {
    throw new Error("$map callback must be a zero-arg arrow function, not a function expression");
  }
  if (arrow.type !== "ArrowFunctionExpression") {
    throw new Error("$map callback must be a zero-arg arrow function");
  }
  if (arrow.params.length > 0) {
    throw new Error("A $map callback cannot declare parameters");
  }
  let results;
  if (resultsArg) {
    if (resultsArg.type !== "Identifier") {
      throw new Error("$map results must be a bare array cell");
    }
    results = resultsArg.name;
  }
  const bodyChildFunctions = /* @__PURE__ */ new Map();
  const bodyHandledStatements = /* @__PURE__ */ new Set();
  const block = getFunctionBody(arrow);
  let body2;
  if (block) {
    body2 = parseStatementList(block, bodyChildFunctions, bodyHandledStatements, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing);
  } else {
    const action = parseActionExpression(arrow.body, bodyChildFunctions, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing);
    if (!action) {
      throw new Error("Unsupported $map callback expression");
    }
    body2 = [action];
  }
  return {
    id: UNSTAMPED_ID,
    kind: "map",
    receiver,
    results,
    body: body2,
    loc: locOf(expression)
  };
}
function mapReceiverFrom(node2, availableHostModules) {
  if (node2.type === "Identifier") {
    if (availableHostModules.has(node2.name))
      return void 0;
    return { kind: "cell", name: node2.name };
  }
  if (node2.type === "MemberExpression" && !node2.computed && node2.object.type === "Identifier" && (node2.object.name === "args" || node2.object.name === "returns") && node2.property.type === "Identifier") {
    return {
      kind: "channel",
      namespace: node2.object.name,
      key: node2.property.name
    };
  }
  return void 0;
}
function parseInvokeCall(expression, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing) {
  const argument = expression.arguments[0];
  if (expression.arguments.length !== 1 || !argument) {
    throw new Error("invoke() takes exactly one zero-arg arrow function");
  }
  if (argument.type === "FunctionExpression") {
    throw new Error("invoke() must use a zero-arg arrow function, not a function expression");
  }
  if (argument.type !== "ArrowFunctionExpression") {
    throw new Error("invoke() must use a zero-arg arrow function");
  }
  if (argument.params.length > 0) {
    throw new Error("An invoke body cannot declare parameters");
  }
  const id2 = UNSTAMPED_ID;
  const bodyChildFunctions = /* @__PURE__ */ new Map();
  const bodyHandledStatements = /* @__PURE__ */ new Set();
  const block = getFunctionBody(argument);
  let body2;
  if (block) {
    body2 = parseStatementList(block, bodyChildFunctions, bodyHandledStatements, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing);
  } else {
    const action = parseActionExpression(argument.body, bodyChildFunctions, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, defaultDeflectWhen, enclosing);
    if (!action) {
      throw new Error("Unsupported invoke body expression");
    }
    body2 = [action];
  }
  return {
    id: id2,
    kind: "invoke",
    body: body2,
    loc: locOf(expression)
  };
}
function parseTriggerArrowFunction(expression, label, availableHostModules) {
  if (expression.type !== "ArrowFunctionExpression") {
    throw new Error(`${label} must be an arrow function`);
  }
  const body2 = getHookBodyStatements(expression, "return");
  if (!body2)
    throw new Error(`${label} must be a function`);
  return parseTriggerStatements(body2, availableHostModules);
}
function parseResolutionDefinition(expression, label, availableHostModules) {
  if (expression.type === "ArrowFunctionExpression") {
    return parseTriggerArrowFunction(expression, label, availableHostModules);
  }
  const question = parseSemanticString(expression, availableHostModules);
  return [
    {
      id: UNSTAMPED_ID,
      kind: "return",
      value: {
        id: UNSTAMPED_ID,
        kind: "judge",
        question,
        loc: locOf(expression)
      },
      loc: locOf(expression)
    }
  ];
}
function createInstructionAction(template, mode, loc, hostParams, resolveWhen, deflectWhen) {
  return {
    id: UNSTAMPED_ID,
    kind: "instruction",
    mode,
    template,
    hostParams,
    resolveWhen,
    deflectWhen,
    loc
  };
}
function parseInstructionCall(expression, availableHostModules, defaultDeflectWhen) {
  const callee = expression.callee.type === "Identifier" ? expression.callee.name : void 0;
  if (callee !== "$instructLoop" && callee !== "$instruct") {
    throw new Error("Unsupported instruction call");
  }
  const textArg = expression.arguments[0];
  if (!textArg || textArg.type === "SpreadElement") {
    throw new Error(`${callee}() requires instruction text`);
  }
  const template = parseSemanticString(textArg, availableHostModules);
  rejectUnsupportedInstructionIml(template);
  if (expression.arguments.length > 2) {
    throw new Error(`${callee}() accepts at most an instruction and one options object`);
  }
  let resolveWhen;
  let deflectWhen;
  let hostParams;
  const optionsArg = expression.arguments[1];
  if (optionsArg) {
    if (optionsArg.type === "SpreadElement" || optionsArg.type !== "ObjectExpression") {
      throw new Error(`${callee}() options must be an object literal`);
    }
    for (const property of optionsArg.properties) {
      if (property.type === "SpreadElement") {
        throw new Error(`${callee}() options do not support spread`);
      }
      if (property.computed) {
        throw new Error(`${callee}() options do not support computed keys`);
      }
      const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : void 0;
      if (key !== "resolveWhen" && key !== "deflectWhen" && key !== "hostParams") {
        throw new Error(`${callee}() has unsupported option key: ${key ?? "<computed>"}`);
      }
      if (key === "hostParams") {
        hostParams = parseHostParamsValue(property.value, `${callee}().hostParams`);
        continue;
      }
      const parsed = parseResolutionDefinition(property.value, `${callee}().${key}`, availableHostModules);
      if (key === "resolveWhen")
        resolveWhen = parsed;
      if (key === "deflectWhen")
        deflectWhen = parsed;
    }
  }
  const mode = callee === "$instruct" ? "once" : "persistent";
  const resolutionIssue = instructionResolutionIssue({ mode, resolveWhen });
  if (resolutionIssue)
    throw new Error(resolutionIssue);
  const action = createInstructionAction(template, mode, locOf(expression), hostParams, resolveWhen, deflectWhen ?? defaultDeflectWhen);
  if (deflectWhen === void 0 && defaultDeflectWhen !== void 0) {
    action.inheritedDeflectWhen = true;
  }
  return action;
}
function parseHostParamsValue(expression, context) {
  if (expression.type === "Literal") {
    const value = expression.value;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    throw new Error(`${context} only supports literal metadata values`);
  }
  if (expression.type === "ArrayExpression") {
    return expression.elements.map((element) => {
      if (!element || element.type === "SpreadElement") {
        throw new Error(`${context} arrays do not support holes or spread`);
      }
      return parseHostParamsValue(element, context);
    });
  }
  if (expression.type === "ObjectExpression") {
    return parseParamsObject(expression, context);
  }
  throw new Error(`${context} only supports literal metadata values`);
}
function parseParamsObject(expression, context) {
  const value = {};
  for (const property of expression.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(`${context} objects do not support spread`);
    }
    if (property.computed) {
      throw new Error(`${context} objects do not support computed keys`);
    }
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : void 0;
    if (!key) {
      throw new Error(`${context} objects require string keys`);
    }
    value[key] = parseHostParamsValue(property.value, context);
  }
  return value;
}
function parseEnterCall(expression, availableImports, visibleNodeNames, visibleCellNames, enclosing) {
  const target2 = parseTarget(expression.arguments[0], "enter", {
    availableImports,
    visibleNodeNames,
    enclosing
  });
  if (expression.arguments.length > 2) {
    throw new Error("$enter() accepts a target and an optional options object");
  }
  const optionsArg = expression.arguments[1];
  let args;
  let returns;
  if (optionsArg) {
    if (optionsArg.type === "SpreadElement" || optionsArg.type !== "ObjectExpression") {
      throw new Error("$enter() options must be an object literal");
    }
    const seenKeys = /* @__PURE__ */ new Set();
    for (const property of optionsArg.properties) {
      if (property.type === "SpreadElement") {
        throw new Error("$enter() options do not support spread");
      }
      if (property.computed) {
        throw new Error("$enter() options do not support computed keys");
      }
      const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : void 0;
      if (key !== "args" && key !== "returns") {
        throw new Error(`$enter() has unsupported option key: ${key ?? "<computed>"}`);
      }
      if (seenKeys.has(key)) {
        throw new Error(`$enter() options has duplicate key: ${key}`);
      }
      seenKeys.add(key);
      const parsed = parseEnterChannelMap(property.value, `$enter().${key}`, visibleCellNames);
      if (key === "args")
        args = parsed;
      if (key === "returns")
        returns = parsed;
    }
  }
  return {
    id: UNSTAMPED_ID,
    kind: "enter-node",
    target: target2,
    args,
    returns,
    loc: locOf(expression)
  };
}
function parseEnterLoopCall(expression, availableImports, visibleNodeNames, visibleCellNames, availableHostModules, enclosing) {
  const target2 = parseTarget(expression.arguments[0], "enterLoop", {
    availableImports,
    visibleNodeNames,
    enclosing
  });
  if (expression.arguments.length !== 2) {
    throw new Error("$enterLoop() accepts a target and one options object");
  }
  const optionsArg = expression.arguments[1];
  if (!optionsArg || optionsArg.type === "SpreadElement" || optionsArg.type !== "ObjectExpression") {
    throw new Error("$enterLoop() options must be an object literal");
  }
  let resolveWhen;
  let args;
  let returns;
  const seenKeys = /* @__PURE__ */ new Set();
  for (const property of optionsArg.properties) {
    if (property.type === "SpreadElement") {
      throw new Error("$enterLoop() options do not support spread");
    }
    if (property.computed) {
      throw new Error("$enterLoop() options do not support computed keys");
    }
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" && typeof property.key.value === "string" ? property.key.value : void 0;
    if (key !== "resolveWhen" && key !== "args" && key !== "returns") {
      throw new Error(`$enterLoop() has unsupported option key: ${key ?? "<computed>"}`);
    }
    if (seenKeys.has(key)) {
      throw new Error(`$enterLoop() options has duplicate key: ${key}`);
    }
    seenKeys.add(key);
    if (key === "resolveWhen") {
      resolveWhen = parseResolutionDefinition(property.value, "$enterLoop().resolveWhen", availableHostModules);
      continue;
    }
    const parsed = parseEnterChannelMap(property.value, `$enterLoop().${key}`, visibleCellNames);
    if (key === "args")
      args = parsed;
    if (key === "returns")
      returns = parsed;
  }
  if (!resolveWhen) {
    throw new Error("$enterLoop() requires resolveWhen");
  }
  return {
    id: UNSTAMPED_ID,
    kind: "enter-loop",
    target: target2,
    resolveWhen,
    args,
    returns,
    loc: locOf(expression)
  };
}
function parseEnterChannelMap(expression, label, visibleCellNames) {
  if (expression.type !== "ObjectExpression") {
    throw new Error(`${label} must be an object literal`);
  }
  const isReturns = label.endsWith(".returns");
  const boundCells = /* @__PURE__ */ new Set();
  const mapping = {};
  for (const property of expression.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(`${label} does not support spread`);
    }
    if (property.computed) {
      throw new Error(`${label} does not support computed keys`);
    }
    if (property.key.type !== "Identifier") {
      throw new Error(`${label} keys must be identifiers`);
    }
    const key = property.key.name;
    if (mapping[key]) {
      throw new Error(`${label} has duplicate key: ${key}`);
    }
    const value = property.value;
    if (value.type === "MemberExpression" && !value.computed && value.object.type === "Identifier" && value.object.name === "args" && value.property.type === "Identifier") {
      if (isReturns) {
        throw new Error(`${label}.${key} cannot bind an args projection to a returns sink`);
      }
      mapping[key] = { kind: "argsProjection", key: value.property.name };
      continue;
    }
    if (value.type === "MemberExpression" && !value.computed && value.object.type === "Identifier" && value.object.name === "span" && value.property.type === "Identifier") {
      const member = value.property.name;
      if (member === "item" || member === "index") {
        if (isReturns) {
          throw new Error(`${label}.${key} cannot bind span.${member} to a returns sink`);
        }
        mapping[key] = { kind: "span", owner: "map", key: member };
        continue;
      }
      if (member === "result") {
        if (!isReturns) {
          throw new Error(`${label}.${key} cannot bind span.result as an args source`);
        }
        mapping[key] = { kind: "span", owner: "map", key: "result" };
        continue;
      }
      throw new Error(`${label}.${key} references an unknown span member: span.${member}`);
    }
    if (value.type !== "Identifier") {
      throw new Error(`${label}.${key} must reference a caller cell identifier or args.* projection`);
    }
    if (!visibleCellNames.has(value.name)) {
      throw new Error(`${label}.${key} references unknown caller cell: ${value.name}`);
    }
    if (isReturns && boundCells.has(value.name)) {
      throw new Error(`${label} binds caller cell ${value.name} more than once`);
    }
    boundCells.add(value.name);
    mapping[key] = { kind: "cell", cell: value.name };
  }
  return mapping;
}
function parseObserveCall(expression, method, availableHostModules = /* @__PURE__ */ new Map(), expressionContext) {
  const cellArg = expression.arguments[0];
  if (cellArg && cellArg.type === "ObjectExpression") {
    return parseObserveGroupCall(expression, method, cellArg);
  }
  if (!cellArg || cellArg.type === "SpreadElement") {
    throw new Error(`$${method}() requires a cell target or a cell group object as the first argument`);
  }
  const target2 = parseCellTarget(cellArg, availableHostModules, expressionContext);
  assertOrdinaryCellTarget(target2, `$${method}()`);
  const questionArg = expression.arguments[1];
  const question = questionArg && questionArg.type !== "SpreadElement" ? parseSemanticString(questionArg, availableHostModules, expressionContext) : void 0;
  return {
    id: UNSTAMPED_ID,
    kind: method,
    target: target2,
    question,
    loc: locOf(expression)
  };
}
function parseObserveGroupCall(expression, method, objectArg) {
  if (expression.arguments.length !== 1) {
    throw new Error(`$${method}({ ... }) takes only the cell group; each cell uses its own observing question`);
  }
  const targets = [];
  for (const property of objectArg.properties) {
    if (property.type === "SpreadElement") {
      throw new Error(`$${method}({ ... }) does not support spread`);
    }
    if (property.computed || property.key.type !== "Identifier") {
      throw new Error(`$${method}({ ... }) does not support computed keys`);
    }
    if (!property.shorthand || property.value.type !== "Identifier" || property.value.name !== property.key.name) {
      throw new Error(`$${method}({ ... }) uses same-name binding; rename is not supported for ${property.key.name}`);
    }
    const name2 = property.key.name;
    if (targets.some(([root]) => root === name2)) {
      throw new Error(`$${method}({ ... }) lists cell ${name2} more than once`);
    }
    targets.push([name2]);
  }
  if (targets.length === 0) {
    throw new Error(`$${method}({ ... }) requires at least one cell`);
  }
  return {
    id: UNSTAMPED_ID,
    kind: method === "observe" ? "observeGroup" : "observeOrAskGroup",
    targets,
    loc: locOf(expression)
  };
}
function assertOrdinaryCellTarget(target2, owner) {
  const [root] = target2;
  if (root === "args" || root === "returns" || root === "span") {
    throw new Error(`${owner} cannot target reserved namespace ${root}`);
  }
}
function parseCellMutationCall(expression, availableHostModules, context, expressionContext) {
  if (expression.callee.type !== "MemberExpression")
    return void 0;
  if (expression.callee.computed)
    return void 0;
  if (expression.callee.property.type !== "Identifier")
    return void 0;
  const method = expression.callee.property.name;
  if (method !== "$set" && method !== "$unset")
    return void 0;
  const calleeObject = expression.callee.object;
  if (calleeObject.type === "Super")
    return void 0;
  if (method === "$unset") {
    if (expression.arguments.length !== 0) {
      throw new Error("$unset() does not accept arguments");
    }
    const target3 = parseCellTarget(calleeObject, availableHostModules, expressionContext);
    assertOrdinaryCellTarget(target3, "$unset()");
    if (target3.length !== 1) {
      throw new Error("$unset() requires a direct cell target");
    }
    return {
      id: UNSTAMPED_ID,
      kind: "unset",
      target: target3,
      loc: locOf(expression)
    };
  }
  if (calleeObject.type === "Identifier" && calleeObject.name === "returns") {
    throw new Error("returns.$set(...) is not supported");
  }
  const valueArg = expression.arguments[0];
  if (!valueArg || valueArg.type === "SpreadElement") {
    throw new Error("$set() requires a value");
  }
  if (expression.arguments.length !== 1) {
    throw new Error("$set() takes exactly one value");
  }
  const value = parseExpression(valueArg, availableHostModules, true, expressionContext);
  if (calleeObject.type === "MemberExpression" && !calleeObject.computed && calleeObject.object.type === "Identifier" && calleeObject.property.type === "Identifier" && calleeObject.object.name === "returns") {
    if (context !== "effects") {
      throw new Error("returns.*.$set(...) is only allowed inside this.effects");
    }
    return {
      id: UNSTAMPED_ID,
      kind: "set-return",
      key: calleeObject.property.name,
      value,
      loc: locOf(expression)
    };
  }
  const target2 = parseCellTarget(calleeObject, availableHostModules, expressionContext);
  assertOrdinaryCellTarget(target2, "$set()");
  return {
    id: UNSTAMPED_ID,
    kind: "set",
    target: target2,
    value,
    loc: locOf(expression)
  };
}
function parseTriggerStatements(statements, availableHostModules) {
  return statements.flatMap((statement2) => {
    if (statement2.type === "LabeledStatement") {
      if (statement2.label.type !== "Identifier") {
        throw new Error("this.trigger labels must use identifier names");
      }
      if (statement2.body.type !== "BlockStatement") {
        throw new Error("this.trigger labels must target a block statement");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "label",
          label: statement2.label.name,
          body: parseTriggerStatements(statement2.body.body, availableHostModules),
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type === "BreakStatement") {
      if (!statement2.label || statement2.label.type !== "Identifier") {
        throw new Error("this.trigger break statements must specify a label");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "break",
          label: statement2.label.name,
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type === "IfStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "if",
          test: parseExpression(statement2.test, availableHostModules, true),
          consequent: parseTriggerStatements(getBlockStatements(statement2.consequent), availableHostModules),
          alternate: statement2.alternate ? parseTriggerStatements(getBlockStatements(statement2.alternate), availableHostModules) : void 0,
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type === "ReturnStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "return",
          value: statement2.argument ? parseExpression(statement2.argument, availableHostModules, true) : void 0,
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type !== "ExpressionStatement") {
      throw unsupportedArcStatement("this.trigger", statement2);
    }
    const expression = statement2.expression;
    if (expression.type !== "CallExpression") {
      throw new Error(`Unsupported this.trigger expression statement: ${expression.type}`);
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "$observe") {
      return [
        parseObserveCall(expression, "observe", availableHostModules)
      ];
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "judge") {
      throw new Error("judge() must be used inside an expression");
    }
    const mutation = parseCellMutationCall(expression, availableHostModules, "action");
    if (mutation?.kind === "set" || mutation?.kind === "unset") {
      return [mutation];
    }
    throw new Error("Unsupported this.trigger call");
  });
}
function parseGuardStatements(statements, availableHostModules) {
  return statements.flatMap((statement2) => {
    if (statement2.type === "LabeledStatement") {
      if (statement2.label.type !== "Identifier") {
        throw new Error("this.guard labels must use identifier names");
      }
      if (statement2.body.type !== "BlockStatement") {
        throw new Error("this.guard labels must target a block statement");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "label",
          label: statement2.label.name,
          body: parseGuardStatements(statement2.body.body, availableHostModules),
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type === "BreakStatement") {
      if (!statement2.label || statement2.label.type !== "Identifier") {
        throw new Error("this.guard break statements must specify a label");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "break",
          label: statement2.label.name,
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type === "IfStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "if",
          test: parseExpression(statement2.test, availableHostModules, true),
          consequent: parseGuardStatements(getBlockStatements(statement2.consequent), availableHostModules),
          alternate: statement2.alternate ? parseGuardStatements(getBlockStatements(statement2.alternate), availableHostModules) : void 0,
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type === "ReturnStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "return",
          value: statement2.argument ? parseGuardReturnValue(statement2.argument, availableHostModules) : void 0,
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type !== "ExpressionStatement") {
      throw unsupportedArcStatement("this.guard", statement2);
    }
    const expression = statement2.expression;
    if (expression.type !== "CallExpression") {
      throw new Error(`Unsupported this.guard expression statement: ${expression.type}`);
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "$observe") {
      return [
        parseObserveCall(expression, "observe", availableHostModules)
      ];
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "judge") {
      throw new Error("judge() must be used inside an expression");
    }
    const mutation = parseCellMutationCall(expression, availableHostModules, "action");
    if (mutation?.kind === "set" || mutation?.kind === "unset") {
      return [mutation];
    }
    throw new Error("Unsupported this.guard call");
  });
}
function parseCatchStatements(statements, availableHostModules, availableImports, visibleNodeNames, enclosing, hook = "catchDeflection") {
  const expressionContext = {
    ...hook === "catchDeflection" ? { deflectionTargets: { availableImports, visibleNodeNames, enclosing } } : { allowInterruption: true }
  };
  const parseHookExpression = (expression) => parseExpression(expression, availableHostModules, true, expressionContext);
  return statements.flatMap((statement2) => {
    if (statement2.type === "LabeledStatement") {
      if (statement2.label.type !== "Identifier") {
        throw new Error(`this.${hook} labels must use identifier names`);
      }
      if (statement2.body.type !== "BlockStatement") {
        throw new Error(`this.${hook} labels must target a block statement`);
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "label",
          label: statement2.label.name,
          body: parseCatchStatements(statement2.body.body, availableHostModules, availableImports, visibleNodeNames, enclosing, hook),
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type === "BreakStatement") {
      if (!statement2.label || statement2.label.type !== "Identifier") {
        throw new Error(`this.${hook} break statements must specify a label`);
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "break",
          label: statement2.label.name,
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type === "IfStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "if",
          test: parseHookExpression(statement2.test),
          consequent: parseCatchStatements(getBlockStatements(statement2.consequent), availableHostModules, availableImports, visibleNodeNames, enclosing, hook),
          alternate: statement2.alternate ? parseCatchStatements(getBlockStatements(statement2.alternate), availableHostModules, availableImports, visibleNodeNames, enclosing, hook) : void 0,
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type === "ReturnStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "return",
          value: statement2.argument ? parseHookExpression(statement2.argument) : void 0,
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type !== "ExpressionStatement") {
      throw unsupportedArcStatement(`this.${hook}`, statement2);
    }
    const expression = statement2.expression;
    if (expression.type !== "CallExpression") {
      throw new Error(`Unsupported this.${hook} expression statement: ${expression.type}`);
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "$observe") {
      return [
        parseObserveCall(expression, "observe", availableHostModules, expressionContext)
      ];
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "$observeOrAsk") {
      return [
        parseObserveCall(expression, "observeOrAsk", availableHostModules, expressionContext)
      ];
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "judge") {
      throw new Error("judge() must be used inside an expression");
    }
    const mutation = parseCellMutationCall(expression, availableHostModules, "action", expressionContext);
    if (mutation?.kind === "set" || mutation?.kind === "unset") {
      return [mutation];
    }
    throw new Error(`Unsupported this.${hook} call`);
  });
}
function parseGuardReturnValue(expression, availableHostModules) {
  const parsed = parseExpression(expression, availableHostModules, true);
  if (parsed.kind !== "literal") {
    throw new Error("this.guard must return State.SKIPPED, State.DEFLECTED, State.COVERED, or undefined");
  }
  if (parsed.value !== "skipped" && parsed.value !== "deflected" && parsed.value !== "covered" && parsed.value !== void 0 && parsed.value !== null) {
    throw new Error("this.guard must return State.SKIPPED, State.DEFLECTED, State.COVERED, or undefined");
  }
  return parsed;
}
function parseEffectStatements(statements, availableHostModules, expressionContext) {
  return statements.flatMap((statement2) => {
    if (statement2.type === "LabeledStatement") {
      if (statement2.label.type !== "Identifier") {
        throw new Error("this.effects labels must use identifier names");
      }
      if (statement2.body.type !== "BlockStatement") {
        throw new Error("this.effects labels must target a block statement");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "label",
          label: statement2.label.name,
          body: parseEffectStatements(statement2.body.body, availableHostModules, expressionContext),
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type === "BreakStatement") {
      if (!statement2.label || statement2.label.type !== "Identifier") {
        throw new Error("this.effects break statements must specify a label");
      }
      return [
        {
          id: UNSTAMPED_ID,
          kind: "break",
          label: statement2.label.name,
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type === "IfStatement") {
      return [
        {
          id: UNSTAMPED_ID,
          kind: "if",
          test: parseExpression(statement2.test, availableHostModules, true, expressionContext),
          consequent: parseEffectStatements(getBlockStatements(statement2.consequent), availableHostModules, expressionContext),
          alternate: statement2.alternate ? parseEffectStatements(getBlockStatements(statement2.alternate), availableHostModules, expressionContext) : void 0,
          loc: locOf(statement2)
        }
      ];
    }
    if (statement2.type !== "ExpressionStatement") {
      throw unsupportedArcStatement("this.effects", statement2);
    }
    const expression = statement2.expression;
    if (expression.type !== "CallExpression") {
      throw new Error(`Unsupported this.effects expression statement: ${expression.type}`);
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "$observe") {
      return [
        parseObserveCall(expression, "observe", availableHostModules, expressionContext)
      ];
    }
    if (expression.callee.type === "Identifier" && expression.callee.name === "$observeOrAsk") {
      throw new Error("$observeOrAsk() is forbidden inside this.effects");
    }
    const mutation = parseCellMutationCall(expression, availableHostModules, "effects", expressionContext);
    if (mutation)
      return [mutation];
    const hostCall = parseStandaloneHostCall(expression, availableHostModules, expressionContext);
    if (hostCall)
      return [hostCall];
    throw new Error("Unsupported this.effects call");
  });
}
function parseStandaloneHostCall(expression, availableHostModules, expressionContext) {
  if (expression.callee.type === "Super")
    return void 0;
  const target2 = parseHostCallTarget(expression.callee, availableHostModules);
  if (!target2) {
    const operation = expression.callee.type === "MemberExpression" && !expression.callee.computed && expression.callee.property.type === "Identifier" ? expression.callee.property.name : expression.callee.type === "MemberExpression" && expression.callee.computed && expression.callee.property.type === "Literal" && typeof expression.callee.property.value === "string" ? expression.callee.property.value : void 0;
    if (operation?.startsWith("$")) {
      throw new Error("Standalone host calls must be rooted in a declared host module import");
    }
    return void 0;
  }
  if (!target2.operation.startsWith("$") || target2.operation.length === 1) {
    if (!target2.operation.startsWith("$")) {
      throw new Error("Standalone host calls require a $-prefixed operation");
    }
    return void 0;
  }
  const args = expression.arguments.map((arg) => {
    if (arg.type === "SpreadElement") {
      throw new Error("Host calls do not support spread arguments");
    }
    return parseHostCallArgument(arg, availableHostModules, true, expressionContext);
  });
  return {
    id: UNSTAMPED_ID,
    kind: "host-call",
    module: target2.module,
    target: target2.path,
    operation: target2.operation.slice(1),
    arguments: args,
    loc: locOf(expression)
  };
}
function rejectUnsupportedInstructionIml(template) {
  const text = template.kind === "literal" ? template.value : template.parts.filter((part) => part.kind === "text").map((part) => part.value).join("");
  if (text.includes(":::when") || text.includes(":::else")) {
    throw new Error("Arc does not support :::when/:::else conditional IML in instruction literals");
  }
}
function findCell2(cells, name2) {
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (cells[index].name === name2)
      return cells[index];
  }
  return void 0;
}
function validateEnterChannelBindings(statement2, cells, issues, options) {
  const callLabel = statement2.kind === "enter-loop" ? "$enterLoop" : "$enter";
  const references = options.references;
  const targetNode = references && !statement2.target.imported ? references.nodeLookup?.get(statement2.target.identifier) : void 0;
  const targetSignature = targetNode?.signature;
  const callerSignature = references?.currentNode.signature;
  const sourceSpec = (source) => {
    if (source.kind === "cell") {
      const cell = findCell2(cells, source.cell);
      if (!cell) {
        issues.push({
          code: "UNKNOWN_CELL",
          message: `Unknown cell: ${source.cell}`,
          loc: statement2.loc
        });
        return void 0;
      }
      const spec2 = cellSpecToChannelSpec(cell);
      if (!spec2) {
        issues.push({
          code: "ENTER_CHANNEL_INCOMPATIBLE",
          message: `${callLabel}() cannot bind cell ${source.cell} across an enter boundary`,
          loc: statement2.loc
        });
      }
      return spec2;
    }
    if (source.kind === "argsProjection") {
      const declared = callerSignature?.args[source.key];
      if (!declared) {
        issues.push({
          code: "UNKNOWN_ARGS_PROJECTION",
          message: `${callLabel}() forwards args.${source.key}, which the enclosing node does not declare`,
          loc: statement2.loc
        });
      }
      return declared;
    }
    if (source.kind === "span") {
      const context = mapContextStack[mapContextStack.length - 1];
      if (!context) {
        issues.push({
          code: "SPAN_OUTSIDE_MAP",
          message: `${callLabel}() binds span.${source.key} outside a $map callback`,
          loc: statement2.loc
        });
        return void 0;
      }
      if (source.key === "index")
        return { type: "index" };
      return source.key === "item" ? context.receiverSpec : context.resultsSpec;
    }
    const unreachable = source;
    throw new Error(`Unexpected enter binding: ${JSON.stringify(unreachable)}`);
  };
  for (const [key, source] of Object.entries(statement2.args ?? {})) {
    const provided = sourceSpec(source);
    if (targetSignature) {
      const declared = targetSignature.args[key];
      if (!declared) {
        issues.push({
          code: "UNDECLARED_ARGS_KEY",
          message: `${callLabel}() binds args.${key}, which ${statement2.target.identifier} does not declare`,
          loc: statement2.loc
        });
      } else if (provided && !reusableSpecCompatible(provided, declared)) {
        issues.push({
          code: "ENTER_CHANNEL_INCOMPATIBLE",
          message: `${callLabel}() args.${key} binding is incompatible with the declared channel type`,
          loc: statement2.loc
        });
      }
    }
  }
  const boundReturnCells = /* @__PURE__ */ new Set();
  for (const [key, source] of Object.entries(statement2.returns ?? {})) {
    if (source.kind === "cell") {
      if (boundReturnCells.has(source.cell)) {
        issues.push({
          code: "ENTER_CHANNEL_DUPLICATE_CELL",
          message: `${callLabel}().returns binds caller cell ${source.cell} more than once`,
          loc: statement2.loc
        });
      }
      boundReturnCells.add(source.cell);
    }
    const provided = sourceSpec(source);
    if (targetSignature) {
      const declared = targetSignature.returns[key];
      if (!declared) {
        issues.push({
          code: "UNDECLARED_RETURNS_KEY",
          message: `${callLabel}() binds returns.${key}, which ${statement2.target.identifier} does not declare`,
          loc: statement2.loc
        });
      } else if (provided && !reusableSpecCompatible(declared, provided)) {
        issues.push({
          code: "ENTER_CHANNEL_INCOMPATIBLE",
          message: `${callLabel}() returns.${key} binding is incompatible with the declared channel type`,
          loc: statement2.loc
        });
      }
    }
  }
}
var TRIGGER_VALIDATION_OPTIONS = {
  forbidArtifactSemanticRefs: true
};
function validateDocumentShape(document, issues) {
  const importNames = /* @__PURE__ */ new Set();
  for (const binding2 of [...document.imports, ...document.hostModules]) {
    if (importNames.has(binding2.localName)) {
      issues.push({
        code: "DUPLICATE_IMPORT",
        message: `Duplicate import binding: ${binding2.localName}`,
        loc: binding2.loc
      });
      continue;
    }
    importNames.add(binding2.localName);
  }
  for (const binding2 of document.imports) {
    if (binding2.source.startsWith(HOST_MODULE_SOURCE_PREFIX))
      issues.push({
        code: "INVALID_IMPORT_BINDING",
        message: "Host imports belong in Document.hostModules",
        loc: binding2.loc
      });
  }
  for (const binding2 of document.hostModules) {
    if (binding2.source !== `${HOST_MODULE_SOURCE_PREFIX}${binding2.module}`)
      issues.push({
        code: "INVALID_IMPORT_BINDING",
        message: "Host import source must name its declared module",
        loc: binding2.loc
      });
  }
  const rootNames = /* @__PURE__ */ new Set();
  for (const root of document.roots) {
    if (rootNames.has(root.identifier)) {
      issues.push({
        code: "DUPLICATE_ARC",
        message: `Duplicate arc: ${root.identifier}`,
        loc: root.loc
      });
      continue;
    }
    rootNames.add(root.identifier);
  }
}
function validateNodeShape(node2, documentImportNames, issues) {
  if (node2.identifier === "invoke") {
    issues.push({
      code: "RESERVED_NAME",
      message: "invoke is a reserved name and cannot name a node",
      loc: node2.loc
    });
  }
  const cells = /* @__PURE__ */ new Set();
  for (const cell of node2.cells) {
    if (cell.name === "invoke") {
      issues.push({
        code: "RESERVED_NAME",
        message: "invoke is a reserved name and cannot name a cell",
        loc: cell.loc
      });
    }
    if (cells.has(cell.name)) {
      issues.push({
        code: "DUPLICATE_CELL",
        message: `Duplicate cell: ${cell.name}`,
        loc: cell.loc
      });
      continue;
    }
    cells.add(cell.name);
  }
  const childNames = /* @__PURE__ */ new Set();
  for (const child of node2.children) {
    if (childNames.has(child.identifier)) {
      issues.push({
        code: "DUPLICATE_NODE",
        message: `Duplicate child node: ${child.identifier}`,
        loc: child.loc
      });
      continue;
    }
    childNames.add(child.identifier);
  }
  const importNames = /* @__PURE__ */ new Set();
  for (const importName of node2.imports) {
    if (importNames.has(importName)) {
      issues.push({
        code: "DUPLICATE_NODE_IMPORT",
        message: `Duplicate node import visibility: ${importName}`,
        loc: node2.loc
      });
      continue;
    }
    importNames.add(importName);
    if (!documentImportNames.has(importName)) {
      issues.push({
        code: "UNKNOWN_IMPORT",
        message: `Node import visibility references an unknown import: ${importName}`,
        loc: node2.loc
      });
    }
  }
}
function resolveTargetBinding(identifier, references) {
  const childNames = new Set(references.currentNode.children.map((child) => child.identifier));
  if (identifier === references.currentNode.identifier && !childNames.has(identifier) && !references.visibleImportNames.has(identifier)) {
    return "self";
  }
  if (references.visibleLocalNodes.has(identifier))
    return "local";
  if (references.visibleImportNames.has(identifier))
    return "imported";
  return void 0;
}
function resolveNodeStateBinding(identifier, references) {
  if (references.visibleLocalNodes.has(identifier))
    return "local";
  if (references.visibleImportNames.has(identifier))
    return "imported";
  return void 0;
}
function validateEnterTarget(target2, issues, loc, references) {
  if (!references)
    return;
  const binding2 = resolveTargetBinding(target2.identifier, references);
  if (!binding2) {
    issues.push({
      code: "UNDEFINED_NODE",
      message: `Unknown node: ${target2.identifier}`,
      loc
    });
    return;
  }
  if (binding2 === "self") {
    issues.push({
      code: "SELF_ENTRY",
      message: `$enter() cannot re-enter the enclosing node ${target2.identifier}`,
      loc
    });
    return;
  }
  if (target2.imported !== (binding2 === "imported")) {
    issues.push({
      code: "TARGET_IMPORT_MISMATCH",
      message: `Target ${target2.identifier} has imported=${target2.imported}, but resolves as ${binding2}`,
      loc
    });
  }
}
function validateDeflectionTarget(target2, issues, loc, references) {
  if (target2.mode !== "canonical") {
    issues.push({
      code: "INVALID_DEFLECTION_TARGET",
      message: "this.deflection.escaped() only accepts a canonical bare target",
      loc
    });
  }
  if (!references)
    return;
  const binding2 = resolveTargetBinding(target2.identifier, references);
  if (!binding2) {
    issues.push({
      code: "UNDEFINED_NODE",
      message: `Unknown node: ${target2.identifier}`,
      loc
    });
    return;
  }
  if (target2.imported !== (binding2 === "imported")) {
    issues.push({
      code: "TARGET_IMPORT_MISMATCH",
      message: `Target ${target2.identifier} has imported=${target2.imported}, but resolves as ${binding2}`,
      loc
    });
  }
}
function cellTargetRoot2(target2) {
  return target2[0];
}
function formatCellTarget(target2) {
  let rendered = target2[0];
  const [, ...accessors] = target2;
  for (const accessor of accessors) {
    if (accessor.kind === "literal") {
      rendered += `[${JSON.stringify(accessor.value)}]`;
    } else if (accessor.kind === "cell") {
      rendered += `[${accessor.name}]`;
    } else {
      rendered += "[...]";
    }
  }
  return rendered;
}
function descendCellTargetSpec(spec2, remainingAccessors, onNonContainer) {
  if (spec2.type !== "array") {
    onNonContainer?.();
    return void 0;
  }
  const leafSpec = spec2.element;
  if (remainingAccessors === 1)
    return leafSpec;
  return descendCellTargetSpec(leafSpec, remainingAccessors - 1, onNonContainer);
}
function resolveCellTargetSpec(rootSpec, accessorCount, onNonContainer) {
  if (accessorCount === 0)
    return { kind: "direct", spec: rootSpec };
  const leafSpec = descendCellTargetSpec(rootSpec, accessorCount, onNonContainer);
  return leafSpec ? { kind: "decorated", spec: leafSpec } : void 0;
}
function cellTargetSpec(target2, cells) {
  const rootSpec = findCell2(cells, cellTargetRoot2(target2));
  if (!rootSpec)
    return void 0;
  return resolveCellTargetSpec(rootSpec, target2.length - 1);
}
function validateCellTarget(target2, cells, nodes, issues, options, loc) {
  const [root, ...accessors] = target2;
  const rootCell = findCell2(cells, root);
  if (!rootCell) {
    issues.push({
      code: "UNKNOWN_CELL",
      message: `Unknown cell: ${root}`,
      loc
    });
  } else if (accessors.length > 0) {
    recordCellRead(root);
  }
  for (const accessor of accessors) {
    validateExpression(accessor, cells, nodes, issues, options);
    if (expressionIsArray(accessor, cells, options.references?.currentNode.signature, options)) {
      issues.push({
        code: "ARRAY_AS_INDEX",
        message: "An array cannot be used as an array index",
        loc
      });
    }
  }
  if (!rootCell)
    return void 0;
  return resolveCellTargetSpec(rootCell, accessors.length, () => {
    issues.push({
      code: "CELL_TARGET_NON_CONTAINER",
      message: `Cell target ${formatCellTarget(target2)} accesses through a non-container value`,
      loc
    });
  });
}
function validateObserveTarget(statement2, cells, nodes, issues, options) {
  const targetSpec = validateCellTarget(statement2.target, cells, nodes, issues, options, statement2.loc);
  if (!targetSpec)
    return;
  if (!isObservableCellSpec(targetSpec.spec)) {
    issues.push({
      code: "NON_OBSERVABLE_CELL",
      message: `$${statement2.kind}() requires an observable cell: ${formatCellTarget(statement2.target)}`,
      loc: statement2.loc
    });
  }
}
function validateObserveGroupTarget(statement2, cells, nodes, issues, options) {
  const method = statement2.kind === "observeGroup" ? "observe" : "observeOrAsk";
  for (const target2 of statement2.targets) {
    const targetSpec = validateCellTarget(target2, cells, nodes, issues, options, statement2.loc);
    if (!targetSpec)
      continue;
    if (!isObservableCellSpec(targetSpec.spec)) {
      issues.push({
        code: "NON_OBSERVABLE_CELL",
        message: `$${method}({ ... }) requires an observable cell: ${formatCellTarget(target2)}`,
        loc: statement2.loc
      });
    }
  }
}
function validateSetTarget(statement2, cells, nodes, issues, options) {
  const targetSpec = validateCellTarget(statement2.target, cells, nodes, issues, options, statement2.loc);
  if (!targetSpec)
    return false;
  if (targetSpec.kind === "direct" && !isSettableCellSpec(targetSpec.spec)) {
    issues.push({
      code: "NON_SETTABLE_CELL",
      message: `Cell target cannot be set with $set(): ${formatCellTarget(statement2.target)}`,
      loc: statement2.loc
    });
    return false;
  }
  return true;
}
function validateUnsetTarget(statement2, cells, nodes, issues, options) {
  if (statement2.target.length !== 1) {
    issues.push({
      code: "NON_UNSETTABLE_CELL",
      message: `$unset() requires a direct cell target: ${formatCellTarget(statement2.target)}`,
      loc: statement2.loc
    });
    return false;
  }
  const targetSpec = validateCellTarget(statement2.target, cells, nodes, issues, options, statement2.loc);
  if (!targetSpec)
    return false;
  if (targetSpec.kind !== "direct" || !isSettableCellSpec(targetSpec.spec)) {
    issues.push({
      code: "NON_UNSETTABLE_CELL",
      message: `Cell cannot be unset with $unset(): ${formatCellTarget(statement2.target)}`,
      loc: statement2.loc
    });
    return false;
  }
  return true;
}
function validateNode(node2, context) {
  validateNodeShape(node2, context.documentImportNames, context.issues);
  const cells = [...context.cells, ...node2.cells];
  const childNames = new Set(node2.children.map((child) => child.identifier));
  const visibleLocalNodes = /* @__PURE__ */ new Set([
    ...context.visibleLocalNodes,
    ...childNames
  ]);
  const visibleImportNames = /* @__PURE__ */ new Set([
    ...context.visibleImportNames,
    ...node2.imports
  ]);
  const nodeNames = [...visibleLocalNodes, ...visibleImportNames];
  const nodeLookup = new Map(context.nodeLookup);
  for (const child of node2.children) {
    nodeLookup.set(child.identifier, child);
  }
  const baseOptions = {
    expressionScope: "ordinary",
    hostModules: context.hostModules,
    references: {
      currentNode: node2,
      visibleLocalNodes,
      visibleImportNames,
      nodeLookup
    }
  };
  const triggerOptions = {
    ...baseOptions,
    ...TRIGGER_VALIDATION_OPTIONS
  };
  const catchDeflectionOptions = {
    ...baseOptions,
    expressionScope: "catchDeflection"
  };
  const effectsOptions = {
    ...baseOptions,
    expressionScope: "effects"
  };
  const builder = {
    cells: /* @__PURE__ */ new Set(),
    nodeIdentifiers: /* @__PURE__ */ new Set(),
    channels: /* @__PURE__ */ new Map()
  };
  const previousReadSet = activeReadSet;
  const previousSegReadSets = activeSegReadSets;
  const segReadSets = /* @__PURE__ */ new Map();
  activeReadSet = builder;
  activeSegReadSets = segReadSets;
  try {
    if (node2.guidance !== void 0)
      validateSemanticString(node2.guidance, cells, nodeNames, context.issues, baseOptions);
    for (const cell of node2.cells) {
      if (isScalarObservableCell(cell) && cell.observing !== void 0) {
        validateSemanticString(cell.observing, cells, nodeNames, context.issues, baseOptions);
      }
      if (isArrayCell(cell) && cell.element.type !== "artifact" && cell.element.observing !== void 0) {
        validateSemanticString(cell.element.observing, cells, nodeNames, context.issues, baseOptions);
      }
      if (cell.type === "artifact" && cell.initializer !== void 0) {
        if (containsBriefableExpression(cell.initializer)) {
          context.issues.push({
            code: "INVALID_ARTIFACT_CELL_SPEC",
            message: `Artifact ${cell.name} path cannot contain judge() or host call expressions`,
            loc: cell.loc
          });
        }
        validateExpression(cell.initializer, cells, nodeNames, context.issues, baseOptions);
      }
    }
    for (const statement2 of node2.statements) {
      validateStatement(statement2, cells, nodeNames, context.issues, [], baseOptions);
    }
    lintNodeStatements(node2, {
      lintIssues: context.lintIssues,
      nodeLookup,
      cellTypes: new Map(cells.map((cell) => [cell.name, cell.type])),
      inInvoke: false
    });
    lintNodeBareCellBooleans(node2, context.lintIssues);
    lintNodeReadBeforeSet(node2, context.lintIssues);
    for (const statement2 of node2.trigger ?? []) {
      validateTriggerStatement(statement2, cells, nodeNames, context.issues, [], triggerOptions);
    }
    for (const statement2 of node2.deflectWhen ?? []) {
      validateTriggerStatement(statement2, cells, nodeNames, context.issues, [], baseOptions);
    }
    for (const statement2 of node2.guard ?? []) {
      validateGuardStatement(statement2, cells, nodeNames, context.issues, [], baseOptions);
    }
    for (const statement2 of node2.effects ?? []) {
      validateEffectStatement(statement2, cells, nodeNames, context.issues, [], effectsOptions);
    }
    if (node2.catchInterruption !== void 0) {
      validateInterruptionCompletion(node2.catchInterruption, context.issues);
      for (const statement2 of node2.catchInterruption) {
        validateCatchDeflectionStatement(statement2, cells, nodeNames, context.issues, [], { ...baseOptions, expressionScope: "catchInterruption" });
      }
    }
    for (const statement2 of node2.catchDeflection ?? []) {
      validateCatchDeflectionStatement(statement2, cells, nodeNames, context.issues, [], catchDeflectionOptions);
    }
  } finally {
    activeReadSet = previousReadSet;
    activeSegReadSets = previousSegReadSets;
  }
  segReadSets.set(nodeSegKey("body"), finalizeReadSet(builder));
  context.bySeg.set(node2, segReadSets);
  for (const child of node2.children) {
    validateNode(child, {
      issues: context.issues,
      lintIssues: context.lintIssues,
      cells,
      // Accumulate all ancestor node names, matching parse-time visibility
      // (`nextVisibleNodeNames`) and runtime resolution (`resolveLexicalRef`
      // climbs `lexicalParentRef`). Cells already accumulate above.
      visibleLocalNodes,
      visibleImportNames,
      documentImportNames: context.documentImportNames,
      nodeLookup,
      bySeg: context.bySeg,
      hostModules: context.hostModules
    });
  }
}
function validateStatement(statement2, cells, nodes, issues, labels = [], options = {}) {
  if (statement2.kind === "if") {
    validateExpression(statement2.test, cells, nodes, issues, options);
    checkBooleanValue(statement2.test, cells, options.references?.currentNode.signature, issues, options);
    statement2.consequent.forEach((entry) => validateStatement(entry, cells, nodes, issues, labels, options));
    statement2.alternate?.forEach((entry) => validateStatement(entry, cells, nodes, issues, labels, options));
    return;
  }
  if (statement2.kind === "label") {
    if (labels.includes(statement2.label)) {
      issues.push({
        code: "DUPLICATE_LABEL",
        message: `Duplicate label in scope: ${statement2.label}`,
        loc: statement2.loc
      });
    }
    statement2.body.forEach((entry) => validateStatement(entry, cells, nodes, issues, [...labels, statement2.label], options));
    return;
  }
  if (statement2.kind === "break") {
    if (!labels.includes(statement2.label)) {
      issues.push({
        code: "UNKNOWN_LABEL",
        message: `Unknown label: ${statement2.label}`,
        loc: statement2.loc
      });
    }
    return;
  }
  if (statement2.kind === "invoke") {
    const invokeBuilder = {
      cells: /* @__PURE__ */ new Set(),
      nodeIdentifiers: /* @__PURE__ */ new Set(),
      channels: /* @__PURE__ */ new Map()
    };
    activeInvokeBuilders.push(invokeBuilder);
    try {
      statement2.body.forEach((entry) => validateStatement(entry, cells, nodes, issues, [], options));
    } finally {
      activeInvokeBuilders.pop();
    }
    activeSegReadSets?.set(invokeSegKey(statement2.id), finalizeReadSet(invokeBuilder));
    return;
  }
  if (statement2.kind === "observe" || statement2.kind === "observeOrAsk") {
    validateObserveTarget(statement2, cells, nodes, issues, options);
    if (statement2.question !== void 0) {
      validateSemanticString(statement2.question, cells, nodes, issues, options);
    }
    return;
  }
  if (statement2.kind === "observeGroup" || statement2.kind === "observeOrAskGroup") {
    validateObserveGroupTarget(statement2, cells, nodes, issues, options);
    return;
  }
  if (statement2.kind === "set") {
    validateSetTarget(statement2, cells, nodes, issues, options);
    validateExpression(statement2.value, cells, nodes, issues, options);
    checkTypedCellAssignment(statement2, cells, options.references?.currentNode.signature, issues, options);
    return;
  }
  if (statement2.kind === "unset") {
    validateUnsetTarget(statement2, cells, nodes, issues, options);
    return;
  }
  if (statement2.kind === "set-return") {
    issues.push({
      code: "SET_RETURN_OUTSIDE_EFFECTS",
      message: "returns.*.$set(...) is only allowed inside this.effects",
      loc: statement2.loc
    });
    validateExpression(statement2.value, cells, nodes, issues, options);
    return;
  }
  if (statement2.kind === "enter-node" || statement2.kind === "enter-loop") {
    validateEnterTarget(statement2.target, issues, statement2.loc, options.references);
    validateEnterChannelBindings(statement2, cells, issues, options);
    if (statement2.kind === "enter-loop") {
      for (const entry of statement2.resolveWhen) {
        validateTriggerStatement(entry, cells, nodes, issues, [], options);
      }
    }
    return;
  }
  if (statement2.kind === "set-span") {
    const context = mapContextStack[mapContextStack.length - 1];
    if (!context) {
      issues.push({
        code: "SPAN_OUTSIDE_MAP",
        message: "span.result is only available inside a $map callback",
        loc: statement2.loc
      });
    } else {
      checkTypedAssignable(context.resultsSpec, statement2.value, cells, options.references?.currentNode.signature, "SPAN_TYPE", "span.result.$set() value type is incompatible with the results element type", issues, statement2.loc, options);
    }
    validateExpression(statement2.value, cells, nodes, issues, options);
    return;
  }
  if (statement2.kind === "map") {
    validateMapStatement(statement2, cells, nodes, issues, options);
    return;
  }
  if (statement2.kind === "host-call") {
    for (const argument of statement2.arguments) {
      validateHostCallArgument(argument, cells, nodes, issues, options);
    }
    validateHostCall(statement2, cells, issues, options);
    return;
  }
  if (statement2.kind !== "instruction") {
    const unreachable = statement2;
    throw new Error(`Unexpected action statement: ${JSON.stringify(unreachable)}`);
  }
  validateSemanticString(statement2.template, cells, nodes, issues, options);
  for (const entry of statement2.resolveWhen ?? []) {
    validateTriggerStatement(entry, cells, nodes, issues, [], options);
  }
  for (const entry of statement2.deflectWhen ?? []) {
    validateTriggerStatement(entry, cells, nodes, issues, [], options);
  }
}
function arrayReferenceElementSpec(ref2, cells, signature2) {
  if (ref2.kind === "cell") {
    const cell = findCell2(cells, ref2.name);
    return cell && isArrayCell(cell) ? cell.element : void 0;
  }
  const spec2 = signature2?.[ref2.namespace]?.[ref2.key];
  return spec2?.type === "array" ? spec2.element : void 0;
}
function arrayCellElementSpec(name2, cells) {
  const cell = findCell2(cells, name2);
  return cell && isArrayCell(cell) ? cell.element : void 0;
}
function producerContext(cells, signature2, options = {}) {
  const map2 = mapContextStack[mapContextStack.length - 1];
  return {
    cells,
    signature: signature2,
    map: map2 ? {
      receiverSpec: map2.receiverSpec,
      resultSpec: map2.resultsSpec
    } : void 0,
    resolveHostOperation: options.hostModules === void 0 ? void 0 : (call) => {
      const resolution = resolveHostOperation(options.hostModules, call);
      return resolution.kind === "resolved" ? resolution.operation : void 0;
    }
  };
}
function checkNumericOperand(expression, op, side, cells, signature2, issues, options) {
  const judgment = arithmeticRule.checkProducer(expression, producerContext(cells, signature2, options));
  if (judgment.kind === "incompatible") {
    issues.push({
      code: "NON_NUMERIC_ARITHMETIC_OPERAND",
      message: `Arithmetic operator ${op} requires a numeric ${side} operand`
    });
  }
}
function checkNumIsFiniteArgument(expression, cells, signature2, issues, options) {
  const judgment = numIsFiniteRule.checkProducer(expression, producerContext(cells, signature2, options));
  if (judgment.kind === "incompatible") {
    issues.push({
      code: "NON_NUMERIC_IS_FINITE_ARGUMENT",
      message: "Num.isFinite requires a numeric argument"
    });
  }
}
function checkTypedAssignable(target2, value, cells, signature2, code, label, issues, loc, options) {
  if (!target2)
    return;
  const judgment = judgeProducerLanding(resolveProducer(value, producerContext(cells, signature2, options)), target2);
  if (judgment.kind === "incompatible") {
    issues.push({ code, message: label, loc });
  }
}
function checkTypedCellAssignment(statement2, cells, signature2, issues, options) {
  const targetSpec = cellTargetSpec(statement2.target, cells);
  const destination = targetSpec === void 0 ? void 0 : cellSpecToChannelSpec(targetSpec.spec);
  let code;
  let message;
  if (destination?.type === "artifact") {
    code = "ARTIFACT_VALUE_TYPE";
    message = `${formatCellTarget(statement2.target)}.$set() requires an Artifact value`;
  } else if (statement2.value.kind === "span") {
    code = "SPAN_TYPE";
    message = `span.${statement2.value.key} type is incompatible with ${formatCellTarget(statement2.target)}`;
  } else if (statement2.value.kind === "channel") {
    code = "CHANNEL_VALUE_TYPE";
    message = `${statement2.value.namespace}.${statement2.value.key} type is incompatible with ${formatCellTarget(statement2.target)}`;
  } else {
    code = "CELL_VALUE_TYPE";
    message = `Value type is incompatible with ${formatCellTarget(statement2.target)}`;
  }
  checkTypedAssignable(destination, statement2.value, cells, signature2, code, message, issues, statement2.loc, options);
}
function validateMapStatement(statement2, cells, nodes, issues, options) {
  const signature2 = options.references?.currentNode.signature;
  validateArrayReference(statement2.receiver, "index", cells, issues, signature2);
  if (statement2.results !== void 0) {
    const cell = findCell2(cells, statement2.results);
    if (!cell) {
      issues.push({
        code: "UNKNOWN_CELL",
        message: `Unknown cell: ${statement2.results}`,
        loc: statement2.loc
      });
    } else if (!isArrayCell(cell)) {
      issues.push({
        code: "MAP_RESULTS_NON_ARRAY",
        message: `$map() results cell ${statement2.results} is not an array`,
        loc: statement2.loc
      });
    }
  }
  const receiverCell = statement2.receiver.kind === "cell" ? statement2.receiver.name : void 0;
  checkMapCallbackBody(statement2.body, receiverCell, statement2.results !== void 0, issues);
  const context = {
    receiverSpec: arrayReferenceElementSpec(statement2.receiver, cells, signature2),
    resultsSpec: statement2.results !== void 0 ? arrayCellElementSpec(statement2.results, cells) : void 0
  };
  const mapBuilder = {
    cells: /* @__PURE__ */ new Set(),
    nodeIdentifiers: /* @__PURE__ */ new Set(),
    channels: /* @__PURE__ */ new Map()
  };
  activeInvokeBuilders.push(mapBuilder);
  mapContextStack.push(context);
  try {
    statement2.body.forEach((entry) => validateStatement(entry, cells, nodes, issues, [], options));
  } finally {
    mapContextStack.pop();
    activeInvokeBuilders.pop();
  }
  activeSegReadSets?.set(invokeSegKey(statement2.id), finalizeReadSet(mapBuilder));
}
function checkMapCallbackBody(body2, receiverCell, hasResults, issues) {
  const spanResultBinding = (bindings) => Object.values(bindings ?? {}).some((source) => source.kind === "span" && source.key === "result");
  const visit = (list) => {
    for (const statement2 of list) {
      switch (statement2.kind) {
        case "if":
          visit(statement2.consequent);
          if (statement2.alternate)
            visit(statement2.alternate);
          break;
        case "label":
          visit(statement2.body);
          break;
        case "invoke":
          visit(statement2.body);
          break;
        case "map":
          issues.push({
            code: "MAP_NESTED",
            message: "$map cannot be nested inside a $map callback",
            loc: statement2.loc
          });
          break;
        case "enter-node":
        case "enter-loop":
          if (statement2.target.mode !== "newcopy") {
            issues.push({
              code: "MAP_ENTER_NOT_NEWCOPY",
              message: `$map callback enter target ${statement2.target.identifier} must be newcopy(...)`,
              loc: statement2.loc
            });
          }
          if (!hasResults && spanResultBinding(statement2.returns)) {
            issues.push({
              code: "MAP_SPAN_RESULT_NO_RESULTS",
              message: "span.result is unavailable in a $map without a results binding",
              loc: statement2.loc
            });
          }
          if (receiverCell !== void 0 && Object.values(statement2.returns ?? {}).some((source) => source.kind === "cell" && source.cell === receiverCell)) {
            issues.push({
              code: "MAP_RECEIVER_WRITE",
              message: `$map callback cannot write its receiver ${receiverCell}`,
              loc: statement2.loc
            });
          }
          break;
        case "set":
        case "unset":
        case "observe":
        case "observeOrAsk":
          if (receiverCell !== void 0 && cellTargetRoot2(statement2.target) === receiverCell) {
            issues.push({
              code: "MAP_RECEIVER_WRITE",
              message: `$map callback cannot write its receiver ${receiverCell}`,
              loc: statement2.loc
            });
          }
          break;
        case "observeGroup":
        case "observeOrAskGroup":
          if (receiverCell !== void 0 && statement2.targets.some((target2) => cellTargetRoot2(target2) === receiverCell)) {
            issues.push({
              code: "MAP_RECEIVER_WRITE",
              message: `$map callback cannot write its receiver ${receiverCell}`,
              loc: statement2.loc
            });
          }
          break;
        case "set-span":
          if (!hasResults) {
            issues.push({
              code: "MAP_SPAN_RESULT_NO_RESULTS",
              message: "span.result is unavailable in a $map without a results binding",
              loc: statement2.loc
            });
          }
          break;
      }
    }
  };
  visit(body2);
}
function validateTriggerStatement(statement2, cells, nodes, issues, labels = [], options = {}) {
  if (statement2.kind === "if") {
    validateExpression(statement2.test, cells, nodes, issues, options);
    checkBooleanValue(statement2.test, cells, options.references?.currentNode.signature, issues, options);
    statement2.consequent.forEach((entry) => validateTriggerStatement(entry, cells, nodes, issues, labels, options));
    statement2.alternate?.forEach((entry) => validateTriggerStatement(entry, cells, nodes, issues, labels, options));
    return;
  }
  if (statement2.kind === "label") {
    if (labels.includes(statement2.label)) {
      issues.push({
        code: "DUPLICATE_LABEL",
        message: `Duplicate label in scope: ${statement2.label}`,
        loc: statement2.loc
      });
    }
    statement2.body.forEach((entry) => validateTriggerStatement(entry, cells, nodes, issues, [...labels, statement2.label], options));
    return;
  }
  if (statement2.kind === "break") {
    if (!labels.includes(statement2.label)) {
      issues.push({
        code: "UNKNOWN_LABEL",
        message: `Unknown label: ${statement2.label}`,
        loc: statement2.loc
      });
    }
    return;
  }
  if (statement2.kind === "return") {
    if (statement2.value) {
      validateExpression(statement2.value, cells, nodes, issues, options);
      checkBooleanValue(statement2.value, cells, options.references?.currentNode.signature, issues, options);
    }
    return;
  }
  if (statement2.kind === "observe") {
    validateObserveTarget(statement2, cells, nodes, issues, options);
    if (statement2.question !== void 0) {
      validateSemanticString(statement2.question, cells, nodes, issues, options);
    }
    return;
  }
  if (statement2.kind === "observeGroup") {
    validateObserveGroupTarget(statement2, cells, nodes, issues, options);
    return;
  }
  if (statement2.kind === "set") {
    validateSetTarget(statement2, cells, nodes, issues, options);
    validateExpression(statement2.value, cells, nodes, issues, options);
    checkTypedCellAssignment(statement2, cells, options.references?.currentNode.signature, issues, options);
    return;
  }
  if (statement2.kind === "unset") {
    validateUnsetTarget(statement2, cells, nodes, issues, options);
    return;
  }
  const unreachable = statement2;
  throw new Error(`Unexpected hook statement: ${JSON.stringify(unreachable)}`);
}
function validateGuardStatement(statement2, cells, nodes, issues, labels = [], options = {}) {
  if (statement2.kind === "if") {
    validateExpression(statement2.test, cells, nodes, issues, options);
    checkBooleanValue(statement2.test, cells, options.references?.currentNode.signature, issues, options);
    statement2.consequent.forEach((entry) => validateGuardStatement(entry, cells, nodes, issues, labels, options));
    statement2.alternate?.forEach((entry) => validateGuardStatement(entry, cells, nodes, issues, labels, options));
    return;
  }
  if (statement2.kind === "label") {
    if (labels.includes(statement2.label)) {
      issues.push({
        code: "DUPLICATE_LABEL",
        message: `Duplicate label in scope: ${statement2.label}`,
        loc: statement2.loc
      });
    }
    statement2.body.forEach((entry) => validateGuardStatement(entry, cells, nodes, issues, [...labels, statement2.label], options));
    return;
  }
  if (statement2.kind === "break") {
    if (!labels.includes(statement2.label)) {
      issues.push({
        code: "UNKNOWN_LABEL",
        message: `Unknown label: ${statement2.label}`,
        loc: statement2.loc
      });
    }
    return;
  }
  if (statement2.kind === "return") {
    if (statement2.value) {
      validateExpression(statement2.value, cells, nodes, issues, options);
      if (statement2.value.kind !== "literal" || ![void 0, null, "covered", "skipped", "deflected"].includes(statement2.value.value)) {
        issues.push({
          code: "INVALID_GUARD_RETURN",
          message: "this.guard must return State.SKIPPED, State.DEFLECTED, State.COVERED, or undefined",
          loc: statement2.loc
        });
      }
    }
    return;
  }
  if (statement2.kind === "observe") {
    validateObserveTarget(statement2, cells, nodes, issues, options);
    if (statement2.question !== void 0) {
      validateSemanticString(statement2.question, cells, nodes, issues, options);
    }
    return;
  }
  if (statement2.kind === "observeGroup") {
    validateObserveGroupTarget(statement2, cells, nodes, issues, options);
    return;
  }
  if (statement2.kind === "set") {
    validateSetTarget(statement2, cells, nodes, issues, options);
    validateExpression(statement2.value, cells, nodes, issues, options);
    checkTypedCellAssignment(statement2, cells, options.references?.currentNode.signature, issues, options);
    return;
  }
  if (statement2.kind === "unset") {
    validateUnsetTarget(statement2, cells, nodes, issues, options);
    return;
  }
  const unreachable = statement2;
  throw new Error(`Unexpected hook statement: ${JSON.stringify(unreachable)}`);
}
function validateInterruptionCompletion(statements, issues) {
  function exits(list) {
    const result = /* @__PURE__ */ new Set(["next"]);
    for (const statement2 of list) {
      if (!result.delete("next"))
        break;
      if (statement2.kind === "return") {
        if (!statement2.value || statement2.value.kind === "literal" && typeof statement2.value.value !== "boolean") {
          issues.push({
            code: "INVALID_INTERRUPTION_RETURN",
            message: "this.catchInterruption must explicitly return a boolean",
            loc: statement2.loc
          });
        }
        result.add("return");
      } else if (statement2.kind === "break") {
        result.add(`break:${statement2.label}`);
      } else if (statement2.kind === "if") {
        const literal2 = statement2.test.kind === "literal" ? statement2.test.value : void 0;
        const branches = literal2 === true ? [statement2.consequent] : literal2 === false ? [statement2.alternate ?? []] : [statement2.consequent, statement2.alternate ?? []];
        for (const branch of branches)
          for (const exit of exits(branch))
            result.add(exit);
      } else if (statement2.kind === "label") {
        for (const exit of exits(statement2.body))
          result.add(exit === `break:${statement2.label}` ? "next" : exit);
      } else
        result.add("next");
    }
    return result;
  }
  if (exits(statements).has("next")) {
    issues.push({
      code: "INVALID_INTERRUPTION_RETURN",
      message: "this.catchInterruption must explicitly return a boolean on every completed path"
    });
  }
}
function validateCatchDeflectionStatement(statement2, cells, nodes, issues, labels = [], options = {}) {
  if (statement2.kind === "if") {
    validateExpression(statement2.test, cells, nodes, issues, options);
    checkBooleanValue(statement2.test, cells, options.references?.currentNode.signature, issues, options);
    statement2.consequent.forEach((entry) => validateCatchDeflectionStatement(entry, cells, nodes, issues, labels, options));
    statement2.alternate?.forEach((entry) => validateCatchDeflectionStatement(entry, cells, nodes, issues, labels, options));
    return;
  }
  if (statement2.kind === "label") {
    if (labels.includes(statement2.label)) {
      issues.push({
        code: "DUPLICATE_LABEL",
        message: `Duplicate label in scope: ${statement2.label}`,
        loc: statement2.loc
      });
    }
    statement2.body.forEach((entry) => validateCatchDeflectionStatement(entry, cells, nodes, issues, [...labels, statement2.label], options));
    return;
  }
  if (statement2.kind === "break") {
    if (!labels.includes(statement2.label)) {
      issues.push({
        code: "UNKNOWN_LABEL",
        message: `Unknown label: ${statement2.label}`,
        loc: statement2.loc
      });
    }
    return;
  }
  if (statement2.kind === "return") {
    if (statement2.value) {
      validateExpression(statement2.value, cells, nodes, issues, options);
      checkBooleanValue(statement2.value, cells, options.references?.currentNode.signature, issues, options);
    }
    return;
  }
  if (statement2.kind === "observe" || statement2.kind === "observeOrAsk") {
    validateObserveTarget(statement2, cells, nodes, issues, options);
    if (statement2.question !== void 0) {
      validateSemanticString(statement2.question, cells, nodes, issues, options);
    }
    return;
  }
  if (statement2.kind === "observeGroup" || statement2.kind === "observeOrAskGroup") {
    validateObserveGroupTarget(statement2, cells, nodes, issues, options);
    return;
  }
  if (statement2.kind === "set") {
    validateSetTarget(statement2, cells, nodes, issues, options);
    validateExpression(statement2.value, cells, nodes, issues, options);
    checkTypedCellAssignment(statement2, cells, options.references?.currentNode.signature, issues, options);
    return;
  }
  if (statement2.kind === "unset") {
    validateUnsetTarget(statement2, cells, nodes, issues, options);
    return;
  }
  const unreachable = statement2;
  throw new Error(`Unexpected hook statement: ${JSON.stringify(unreachable)}`);
}
function validateEffectStatement(statement2, cells, nodes, issues, labels = [], options = {}) {
  if (statement2.kind === "if") {
    validateExpression(statement2.test, cells, nodes, issues, options);
    checkBooleanValue(statement2.test, cells, options.references?.currentNode.signature, issues, options);
    statement2.consequent.forEach((entry) => validateEffectStatement(entry, cells, nodes, issues, labels, options));
    statement2.alternate?.forEach((entry) => validateEffectStatement(entry, cells, nodes, issues, labels, options));
    return;
  }
  if (statement2.kind === "label") {
    if (labels.includes(statement2.label)) {
      issues.push({
        code: "DUPLICATE_LABEL",
        message: `Duplicate label in scope: ${statement2.label}`,
        loc: statement2.loc
      });
    }
    statement2.body.forEach((entry) => validateEffectStatement(entry, cells, nodes, issues, [...labels, statement2.label], options));
    return;
  }
  if (statement2.kind === "break") {
    if (!labels.includes(statement2.label)) {
      issues.push({
        code: "UNKNOWN_LABEL",
        message: `Unknown label: ${statement2.label}`,
        loc: statement2.loc
      });
    }
    return;
  }
  if (statement2.kind === "observe") {
    validateObserveTarget(statement2, cells, nodes, issues, options);
    if (statement2.question !== void 0) {
      validateSemanticString(statement2.question, cells, nodes, issues, options);
    }
    return;
  }
  if (statement2.kind === "observeGroup") {
    validateObserveGroupTarget(statement2, cells, nodes, issues, options);
    return;
  }
  if (statement2.kind === "set") {
    validateSetTarget(statement2, cells, nodes, issues, options);
    validateExpression(statement2.value, cells, nodes, issues, options);
    checkTypedCellAssignment(statement2, cells, options.references?.currentNode.signature, issues, options);
    return;
  }
  if (statement2.kind === "unset") {
    validateUnsetTarget(statement2, cells, nodes, issues, options);
    return;
  }
  if (statement2.kind === "set-return") {
    const signature2 = options.references?.currentNode.signature;
    validateExpression(statement2.value, cells, nodes, issues, options);
    checkTypedAssignable(signature2?.returns[statement2.key], statement2.value, cells, signature2, "CHANNEL_VALUE_TYPE", `returns.${statement2.key}.$set() value type is incompatible with the declared channel type`, issues, statement2.loc, options);
    return;
  }
  if (statement2.kind !== "host-call") {
    const unreachable = statement2;
    throw new Error(`Unexpected effect statement: ${JSON.stringify(unreachable)}`);
  }
  for (const arg of statement2.arguments) {
    validateHostCallArgument(arg, cells, nodes, issues, options);
  }
  validateHostCall(statement2, cells, issues, options);
}
function validateHostCallArgument(arg, cells, nodes, issues, options = {}) {
  if (arg.kind === "semantic") {
    validateSemanticString(arg.value, cells, nodes, issues, options);
    return;
  }
  if (arg.kind === "value") {
    if (containsBriefableExpression(arg.value)) {
      issues.push({
        code: "HOST_CALL_ARGUMENT",
        message: "Host call arguments cannot contain briefable expressions",
        loc: briefableExpressionLoc(arg.value)
      });
      return;
    }
    validateExpression(arg.value, cells, nodes, issues, options);
    return;
  }
  if (arg.kind === "array") {
    arg.elements.forEach((item) => validateHostCallArgument(item, cells, nodes, issues, options));
    return;
  }
  if (arg.kind !== "object") {
    const unreachable = arg;
    throw new Error(`Unexpected host argument: ${JSON.stringify(unreachable)}`);
  }
  for (const item of Object.values(arg.value)) {
    validateHostCallArgument(item, cells, nodes, issues, options);
  }
}
function validateHostCall(action, cells, issues, options) {
  if (options.hostModules === void 0)
    return;
  const path = [action.module, ...action.target, action.operation].join(".");
  const resolution = resolveHostOperation(options.hostModules, action);
  if (resolution.kind === "unresolved") {
    if (resolution.reason === "module") {
      issues.push({
        code: "HOST_MODULE_UNDECLARED",
        message: `Host module ${JSON.stringify(action.module)} has no injected declaration`,
        loc: action.loc
      });
    } else if (resolution.reason === "member") {
      issues.push({
        code: "HOST_MEMBER_UNDECLARED",
        message: `Host action ${path} refers to undeclared member ${JSON.stringify(resolution.segment)}`,
        loc: action.loc
      });
    } else {
      issues.push({
        code: "HOST_MEMBER_NOT_OPERATION",
        message: `Host action ${path} does not resolve to an operation`,
        loc: action.loc
      });
    }
    return;
  }
  const operation = resolution.operation;
  if (!acceptsHostArgumentCount(operation, action.arguments.length)) {
    const { min, max } = hostOperationArity(operation);
    issues.push({
      code: "HOST_ARGUMENT_ARITY",
      message: `Host action ${path} requires ${min === max ? max : `${min} to ${max}`} arguments but received ${action.arguments.length}`,
      loc: action.loc
    });
    return;
  }
  const context = producerContext(cells, options.references?.currentNode.signature, options);
  action.arguments.forEach((argument, index) => {
    const parameter = hostParameterValueSpec(operation.parameters[index]);
    if (judgeHostArgument(argument, parameter, context).kind === "incompatible") {
      issues.push({
        code: "HOST_ARGUMENT_TYPE",
        message: `Host action ${path} argument ${index + 1} is incompatible with its declared parameter spec`,
        loc: action.loc
      });
    }
  });
}
function validateSemanticString(value, cells, nodes, issues, options = {}) {
  if (value.kind === "literal")
    return;
  for (const part of value.parts) {
    if (part.kind === "ref" || part.kind === "hostVar")
      continue;
    if (part.kind === "expression") {
      if (containsBriefableExpression(part.expression)) {
        issues.push({
          code: "BRIEFABLE_TEMPLATE_EXPRESSION",
          message: "Template interpolation cannot contain judge() or host call expressions",
          loc: briefableExpressionLoc(part.expression)
        });
        continue;
      }
      validateExpression(part.expression, cells, nodes, issues, options);
      if (expressionIsArtifact(part.expression, cells, options.references?.currentNode.signature, options)) {
        if (options.forbidArtifactSemanticRefs) {
          issues.push({
            code: "ARTIFACT_IN_TRIGGER",
            message: "Artifacts cannot be used inside this.trigger; trigger resolution must not depend on a workspace"
          });
        }
        continue;
      }
      const judgment = interpolationRule.checkProducer(part.expression, producerContext(cells, options.references?.currentNode.signature, options));
      if (judgment.kind === "incompatible") {
        issues.push({
          code: "INVALID_TEMPLATE_INTERPOLATION",
          message: "Value template interpolation cannot render this value",
          loc: briefableExpressionLoc(part.expression)
        });
      }
    }
  }
}
function briefableExpressionLoc(expression) {
  switch (expression.kind) {
    case "judge":
    case "host-call":
      return expression.loc;
    case "regexTest":
      return briefableExpressionLoc(expression.target);
    case "comparison":
    case "arithmetic":
    case "logical":
      return briefableExpressionLoc(expression.left) ?? briefableExpressionLoc(expression.right);
    case "conditional":
      return briefableExpressionLoc(expression.test) ?? briefableExpressionLoc(expression.consequent) ?? briefableExpressionLoc(expression.alternate);
    case "unary":
    case "numericUnary":
    case "numIsFinite":
      return briefableExpressionLoc(expression.argument);
    case "template-string":
      for (const part of expression.parts) {
        if (part.kind === "expression") {
          const loc = briefableExpressionLoc(part.expression);
          if (loc)
            return loc;
        }
      }
      return void 0;
    case "artifact":
      return briefableExpressionLoc(expression.path);
    case "arrayElementRead":
      return briefableExpressionLoc(expression.index);
    case "arrayLiteral":
      for (const element of expression.elements) {
        const loc = briefableExpressionLoc(element);
        if (loc)
          return loc;
      }
      return void 0;
    default:
      return void 0;
  }
}
function expressionIsArray(expression, cells, signature2, options = {}) {
  switch (expression.kind) {
    case "arrayLiteral":
      return true;
    case "cell": {
      const cell = findCell2(cells, expression.name);
      return !!cell && isArrayCell(cell);
    }
    case "channel":
      return signature2?.[expression.namespace][expression.key]?.type === "array";
    case "conditional":
      return expressionIsArray(expression.consequent, cells, signature2, options) && expressionIsArray(expression.alternate, cells, signature2, options);
    case "host-call": {
      const resolution = options.hostModules ? resolveHostOperation(options.hostModules, expression) : void 0;
      return resolution?.kind === "resolved" && resolution.operation.returns?.type === "array";
    }
    default:
      return false;
  }
}
function expressionIsArtifact(expression, cells, signature2, options = {}) {
  return producerGuaranteesArtifact(resolveProducer(expression, producerContext(cells, signature2, options)));
}
function checkBooleanValue(expression, cells, signature2, issues, options) {
  const judgment = booleanRule.checkProducer(expression, producerContext(cells, signature2, options));
  if (judgment.kind === "incompatible") {
    issues.push({
      code: "NON_BOOLEAN_CONDITION",
      message: "Only a boolean value can be used in a boolean position; compare a non-boolean value explicitly"
    });
  }
}
function validateArrayReference(array2, operation, cells, issues, signature2) {
  if (array2.kind === "channel") {
    recordChannelRead(array2.namespace, array2.key);
    const declared = signature2?.[array2.namespace][array2.key];
    if (declared && declared.type !== "array") {
      issues.push({
        code: operation === "index" ? "INDEX_NON_ARRAY" : "LENGTH_NON_ARRAY",
        message: `Channel ${array2.namespace}.${array2.key} is not an array; cannot read ${operation}`
      });
    }
    return;
  }
  recordCellRead(array2.name);
  const cell = findCell2(cells, array2.name);
  if (!cell) {
    issues.push({
      code: "UNKNOWN_CELL",
      message: `Unknown cell: ${array2.name}`
    });
    return;
  }
  if (!isArrayCell(cell)) {
    issues.push({
      code: operation === "index" ? "INDEX_NON_ARRAY" : "LENGTH_NON_ARRAY",
      message: `Cell ${array2.name} is not an array; cannot read ${operation}`
    });
  }
}
function validateExpression(expression, cells, nodes, issues, options = {}) {
  const signature2 = options.references?.currentNode.signature;
  switch (expression.kind) {
    case "arrayElementRead":
      validateArrayReference(expression.array, "index", cells, issues, signature2);
      validateExpression(expression.index, cells, nodes, issues, options);
      if (expressionIsArray(expression.index, cells, signature2, options)) {
        issues.push({
          code: "ARRAY_AS_INDEX",
          message: "An array cannot be used as an array index"
        });
      }
      return;
    case "arrayLength":
      validateArrayReference(expression.array, "length", cells, issues, signature2);
      return;
    case "arrayLiteral":
      for (const element of expression.elements) {
        validateExpression(element, cells, nodes, issues, options);
      }
      return;
    case "span":
      if (mapContextStack.length === 0) {
        issues.push({
          code: "SPAN_OUTSIDE_MAP",
          message: `span.${expression.key} is only available inside a $map callback`
        });
      }
      return;
    case "cell":
    case "isUnset": {
      const name2 = expression.kind === "cell" ? expression.name : expression.cell;
      recordCellRead(name2);
      const cell = findCell2(cells, name2);
      if (!cell) {
        issues.push({
          code: "UNKNOWN_CELL",
          message: `Unknown cell: ${name2}`
        });
        return;
      }
      if (!isValueExpressionCell(cell)) {
        issues.push({
          code: "NON_VALUE_CELL",
          message: `Cell cannot be used as an expression value: ${name2}`
        });
        return;
      }
      return;
    }
    case "nodeState":
      recordNodeStateRead(expression.identifier);
      if (options.references) {
        if (!resolveNodeStateBinding(expression.identifier, options.references)) {
          issues.push({
            code: "UNDEFINED_NODE",
            message: `Unknown node: ${expression.identifier}`
          });
        }
        return;
      }
      if (!nodes.includes(expression.identifier)) {
        issues.push({
          code: "UNDEFINED_NODE",
          message: `Unknown node: ${expression.identifier}`
        });
      }
      return;
    case "deflectionEscaped":
      if (options.expressionScope !== "catchDeflection" && options.expressionScope !== "effects") {
        issues.push({
          code: "DEFLECTION_ESCAPED_OUTSIDE_FINALIZATION",
          message: "this.deflection.escaped(...) is only available inside this.catchDeflection or this.effects"
        });
      }
      validateDeflectionTarget(expression.target, issues, void 0, options.references);
      return;
    case "channel":
      recordChannelRead(expression.namespace, expression.key);
      return;
    case "channelIsUnset":
      recordChannelRead(expression.namespace, expression.key);
      return;
    case "judge":
      validateSemanticString(expression.question, cells, nodes, issues, options);
      return;
    case "host-call":
      for (const arg of expression.arguments) {
        validateHostCallArgument(arg, cells, nodes, issues, options);
      }
      validateHostCall(expression, cells, issues, options);
      return;
    case "regexTest":
      validateExpression(expression.target, cells, nodes, issues, options);
      if (stringOperandRule.checkProducer(expression.target, producerContext(cells, signature2, options)).kind === "incompatible") {
        issues.push({
          code: expressionIsArtifact(expression.target, cells, signature2, options) ? "INVALID_ARTIFACT_OPERATION" : "REGEX_TARGET_TYPE",
          message: expressionIsArtifact(expression.target, cells, signature2, options) ? "Artifacts cannot be used in regular-expression tests" : "Regular-expression tests require a string target"
        });
      }
      return;
    case "dialogTurnsSince":
      validateExpression(expression.receiver, cells, nodes, issues, options);
      validateExpression(expression.baseline, cells, nodes, issues, options);
      return;
    // Dialog reads are bindings, not traversal-visible state: they are pinned
    // per walk rather than bracketed by the read-set, so they record nothing.
    case "dialogCursor":
      return;
    case "scope":
      return;
    case "interruptionId":
    case "interruptionReason":
      if (options.expressionScope !== "catchInterruption") {
        issues.push({
          code: "INTERRUPTION_OUTSIDE_CATCH",
          message: "this.interruption is only available inside this.catchInterruption"
        });
      }
      return;
    case "pendingState":
      if (options.expressionScope !== "effects") {
        issues.push({
          code: "PENDING_STATE_OUTSIDE_EFFECTS",
          message: "this.pendingState is only available inside this.effects"
        });
      }
      return;
    case "enterCount":
      return;
    case "comparison": {
      validateExpression(expression.left, cells, nodes, issues, options);
      validateExpression(expression.right, cells, nodes, issues, options);
      const isOrdering = expression.op === ">" || expression.op === ">=" || expression.op === "<" || expression.op === "<=";
      const decision2 = comparisonRule.checkProducers(expression.op, expression.left, expression.right, producerContext(cells, signature2, options));
      if (decision2.judgment.kind === "incompatible") {
        const artifact = expressionIsArtifact(expression.left, cells, signature2, options) || expressionIsArtifact(expression.right, cells, signature2, options);
        const array2 = expressionIsArray(expression.left, cells, signature2, options) || expressionIsArray(expression.right, cells, signature2, options);
        issues.push({
          code: isOrdering && artifact ? "INVALID_ARTIFACT_OPERATION" : isOrdering && array2 ? "ARRAY_ORDERING" : "COMPARISON_VALUE_TYPE",
          message: isOrdering && artifact ? "Artifacts cannot be ordered" : isOrdering && array2 ? "A whole array cannot be used in an ordering comparison" : "Comparison operands do not have a coherent shared domain"
        });
      }
      return;
    }
    case "arithmetic":
      validateExpression(expression.left, cells, nodes, issues, options);
      validateExpression(expression.right, cells, nodes, issues, options);
      checkNumericOperand(expression.left, expression.op, "left", cells, signature2, issues, options);
      checkNumericOperand(expression.right, expression.op, "right", cells, signature2, issues, options);
      return;
    case "logical":
      validateExpression(expression.left, cells, nodes, issues, options);
      validateExpression(expression.right, cells, nodes, issues, options);
      checkBooleanValue(expression.left, cells, signature2, issues, options);
      checkBooleanValue(expression.right, cells, signature2, issues, options);
      return;
    case "conditional":
      validateExpression(expression.test, cells, nodes, issues, options);
      validateExpression(expression.consequent, cells, nodes, issues, options);
      validateExpression(expression.alternate, cells, nodes, issues, options);
      checkBooleanValue(expression.test, cells, signature2, issues, options);
      return;
    case "unary":
      validateExpression(expression.argument, cells, nodes, issues, options);
      checkBooleanValue(expression.argument, cells, signature2, issues, options);
      return;
    case "numericUnary":
      validateExpression(expression.argument, cells, nodes, issues, options);
      checkNumericOperand(expression.argument, expression.op, "argument", cells, signature2, issues, options);
      return;
    case "numIsFinite":
      validateExpression(expression.argument, cells, nodes, issues, options);
      checkNumIsFiniteArgument(expression.argument, cells, signature2, issues, options);
      return;
    case "template-string":
      for (const part of expression.parts) {
        if (part.kind === "expression") {
          validateExpression(part.expression, cells, nodes, issues, options);
          if (interpolationRule.checkProducer(part.expression, producerContext(cells, signature2, options)).kind === "incompatible") {
            issues.push({
              code: "INVALID_TEMPLATE_INTERPOLATION",
              message: "Value template interpolation cannot render this value",
              loc: briefableExpressionLoc(part.expression)
            });
          }
        }
      }
      return;
    case "artifact":
      validateExpression(expression.path, cells, nodes, issues, options);
      {
        const judgment = artifactPathRule.checkProducer(expression.path, producerContext(cells, signature2, options));
        if (judgment.kind === "incompatible") {
          issues.push({
            code: "ARTIFACT_PATH_TYPE",
            message: "Artifact path expression must produce a string value",
            loc: briefableExpressionLoc(expression.path)
          });
        }
      }
      return;
    case "literal":
      return;
    default: {
      const unreachable = expression;
      throw new Error(`Unexpected value expression: ${JSON.stringify(unreachable)}`);
    }
  }
}

// node_modules/.pnpm/arc@file+..+arc/node_modules/arc/dist/host-utils/host-module-declaration.js
var tokenRecords = /* @__PURE__ */ new WeakMap();
var declarationErrors = /* @__PURE__ */ new WeakSet();
var asyncFunctionPrototype = Object.getPrototypeOf(async function() {
});
var activeCapture;
function define(declaration) {
  if (activeCapture) {
    declarationError(activeCapture.path, "hmd.define() cannot run inside an operation declaration");
  }
  const spec2 = normalizeNamespace(declaration, "$", /* @__PURE__ */ new WeakSet());
  const issue2 = validateHostModuleSpec(spec2)[0];
  if (issue2) {
    declarationError(issue2.path, issue2.detail);
  }
  return spec2;
}
function normalizeNamespace(value, path, visiting) {
  const object = inspectNamespace(value, path);
  if (visiting.has(object)) {
    declarationError(path, "cyclic namespace declarations are unsupported");
  }
  visiting.add(object);
  try {
    const members = [];
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== "string") {
        declarationError(path, "symbol member names are unsupported");
      }
      const memberPath = propertyPath(path, key);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        declarationError(memberPath, "members must be enumerable data properties");
      }
      if (key.length === 0 || key.startsWith("$")) {
        declarationError(memberPath, "member names must be nonempty and cannot begin with $");
      }
      const member = descriptor.value;
      if (typeof member === "function") {
        members.push([key, captureOperation(member, memberPath)]);
      } else {
        members.push([key, normalizeNamespace(member, memberPath, visiting)]);
      }
    }
    return {
      kind: "namespace",
      members: Object.fromEntries(members)
    };
  } catch (error) {
    if (isDeclarationError(error))
      throw error;
    declarationError(path, "declaration object could not be inspected", error);
  } finally {
    visiting.delete(object);
  }
}
function inspectNamespace(value, path) {
  if (!value || typeof value !== "object") {
    declarationError(path, "expected a plain declaration object");
  }
  let array2;
  let prototype;
  try {
    array2 = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
  } catch (error) {
    declarationError(path, "declaration object could not be inspected", error);
  }
  if (array2 || prototype !== Object.prototype && prototype !== null) {
    declarationError(path, "expected a plain declaration object");
  }
  return value;
}
function captureOperation(operation, path) {
  let prototype;
  try {
    prototype = Object.getPrototypeOf(operation);
  } catch (error) {
    declarationError(path, "operation function could not be inspected", error);
  }
  if (prototype === asyncFunctionPrototype) {
    declarationError(path, "operation declarations must be synchronous");
  }
  if (activeCapture) {
    declarationError(path, "operation declaration capture cannot be reentered");
  }
  const frame = { path, tokens: [] };
  activeCapture = frame;
  let result;
  try {
    result = operation();
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => void 0);
      declarationError(path, "operation declarations must be synchronous");
    }
  } catch (error) {
    if (isDeclarationError(error))
      throw error;
    declarationError(path, "operation declaration threw during capture", error);
  } finally {
    activeCapture = void 0;
  }
  let parameterTokens = frame.tokens;
  let returns;
  if (result !== void 0) {
    const resultToken = asToken(result, path, "operation result");
    const record2 = tokenRecords.get(resultToken);
    if (!record2 || record2.frame !== frame || frame.tokens[frame.tokens.length - 1] !== resultToken) {
      declarationError(path, "operation result must be its final captured declaration marker");
    }
    if (!isChannelSpec(record2.spec)) {
      declarationError(path, "operation result must be an Arc channel spec");
    }
    parameterTokens = frame.tokens.slice(0, -1);
    returns = cloneParameterSpec(record2.spec);
  }
  return {
    kind: "operation",
    parameters: parameterTokens.map((token) => {
      const record2 = tokenRecords.get(token);
      if (!record2 || record2.frame !== frame) {
        declarationError(path, "operation parameter marker is invalid");
      }
      return cloneParameterSpec(record2.spec);
    }),
    ...returns ? { returns } : {}
  };
}
function createToken(spec2, children = []) {
  const frame = activeCapture;
  if (!frame) {
    declarationError("$", "hmd markers can only be used inside hmd.define()");
  }
  if (children.length > frame.tokens.length) {
    declarationError(frame.path, "composite declaration markers are invalid");
  }
  const offset2 = frame.tokens.length - children.length;
  for (const [index, child] of children.entries()) {
    const record2 = tokenRecords.get(child);
    if (!record2 || record2.frame !== frame || frame.tokens[offset2 + index] !== child) {
      declarationError(frame.path, "composite markers must consume their current captured children");
    }
  }
  frame.tokens.splice(offset2, children.length);
  const token = Object.freeze({});
  tokenRecords.set(token, {
    frame,
    spec: cloneParameterSpec(spec2)
  });
  frame.tokens.push(token);
  return token;
}
function scalarToken(spec2) {
  return createToken(spec2);
}
function enumToken(values) {
  const copied = inspectStringArray(values, activeCapture?.path ?? "$", "Enum");
  const spec2 = { type: "enum", values: copied };
  const violation2 = validateSpec(spec2);
  if (violation2) {
    declarationError(activeCapture?.path ?? "$", violation2.detail);
  }
  return createToken(spec2);
}
function arrayToken(element) {
  const spec2 = valueTokenSpec(element, activeCapture?.path ?? "$", "Array");
  return createToken({
    type: "array",
    element: spec2
  }, [element]);
}
function tupleToken(elements) {
  const copied = inspectTokenArray(elements, activeCapture?.path ?? "$", "Tuple");
  return createToken({
    type: "tuple",
    elements: copied.map((element) => valueTokenSpec(element, activeCapture?.path ?? "$", "Tuple"))
  }, copied);
}
function omittableToken(value) {
  const spec2 = valueTokenSpec(value, activeCapture?.path ?? "$", "Omittable");
  return createToken({ type: "omittable", spec: spec2 }, [value]);
}
function structToken(fields) {
  const path = activeCapture?.path ?? "$";
  const object = inspectNamespace(fields, path);
  const children = [];
  const entries = [];
  for (const name2 of Reflect.ownKeys(object)) {
    if (typeof name2 !== "string" || !isHostStructFieldName(name2)) {
      declarationError(path, "Struct field names must be nonempty strings and cannot be __proto__, prototype, or constructor");
    }
    const fieldPath2 = propertyPath(path, name2);
    const descriptor = Object.getOwnPropertyDescriptor(object, name2);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      declarationError(fieldPath2, "Struct fields must be enumerable data properties");
    }
    const token = asToken(descriptor.value, fieldPath2, "Struct field");
    children.push(token);
    entries.push([name2, tokenRecords.get(token).spec]);
  }
  const captured = activeCapture?.tokens ?? [];
  children.sort((left, right) => captured.indexOf(left) - captured.indexOf(right));
  return createToken({ type: "struct", fields: Object.fromEntries(entries) }, children);
}
function valueTokenSpec(value, path, owner) {
  const token = asToken(value, path, `${owner} child`);
  const { spec: spec2 } = tokenRecords.get(token);
  if (spec2.type === "omittable") {
    declarationError(path, `${owner} requires a value marker; Omittable is only valid around a whole parameter or Struct field`);
  }
  return spec2;
}
function asToken(value, path, owner) {
  if (!value || typeof value !== "object" && typeof value !== "function") {
    declarationError(path, `${owner} must be a declaration marker`);
  }
  if (!tokenRecords.has(value)) {
    declarationError(path, `${owner} must be a declaration marker`);
  }
  return value;
}
function inspectStringArray(value, path, owner) {
  const elements = inspectOrdinaryArray(value, path, owner);
  return elements.map((element) => {
    if (typeof element !== "string") {
      declarationError(path, `${owner} values must be strings`);
    }
    return element;
  });
}
function inspectTokenArray(value, path, owner) {
  return inspectOrdinaryArray(value, path, owner).map((element) => asToken(element, path, `${owner} element`));
}
function inspectOrdinaryArray(value, path, owner) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      declarationError(path, `${owner} requires an ordinary array`);
    }
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        declarationError(path, `${owner} arrays must be dense enumerable data`);
      }
      result.push(descriptor.value);
    }
    const extra = Reflect.ownKeys(value).find((key) => {
      if (key === "length")
        return false;
      if (typeof key !== "string")
        return true;
      const index = Number(key);
      return !Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= value.length;
    });
    if (extra !== void 0) {
      declarationError(path, `${owner} arrays cannot have extra properties`);
    }
    return result;
  } catch (error) {
    if (isDeclarationError(error))
      throw error;
    declarationError(path, `${owner} array could not be inspected`, error);
  }
}
function isPromiseLike(value) {
  if (!value || typeof value !== "object" && typeof value !== "function") {
    return false;
  }
  return typeof Reflect.get(value, "then") === "function";
}
function isChannelSpec(spec2) {
  switch (spec2.type) {
    case "boolean":
    case "string":
    case "enum":
    case "number":
    case "index":
    case "artifact":
    case "dialogCursor":
      return true;
    case "array":
      return spec2.element.type === "boolean" || spec2.element.type === "string" || spec2.element.type === "enum" || spec2.element.type === "number" || spec2.element.type === "artifact";
    case "omittable":
    case "tuple":
    case "struct":
    case "semanticText":
      return false;
  }
}
function propertyPath(path, key) {
  return `${path}[${JSON.stringify(key)}]`;
}
function isDeclarationError(error) {
  return error instanceof Error && declarationErrors.has(error);
}
function declarationError(path, detail, cause) {
  const error = Object.assign(new Error(`Invalid host module declaration at ${path}: ${detail}`), {
    code: "HOST_MODULE_DECLARATION",
    path,
    ...cause === void 0 ? {} : { cause }
  });
  declarationErrors.add(error);
  throw error;
}
var hmd = Object.freeze({
  define,
  Bool: () => scalarToken({ type: "boolean" }),
  Str: () => scalarToken({ type: "string" }),
  Enum: enumToken,
  Num: () => scalarToken({ type: "number" }),
  Index: () => scalarToken({ type: "index" }),
  Artifact: () => scalarToken({ type: "artifact" }),
  Dialog: Object.freeze({
    Cursor: () => scalarToken({ type: "dialogCursor" })
  }),
  Omittable: omittableToken,
  Array: arrayToken,
  Tuple: tupleToken,
  Struct: structToken,
  SemanticText: () => scalarToken({ type: "semanticText" })
});

// src/service/host-module-declarations.ts
var timeDeclaration = hmd.define({
  addTimeout: (milliseconds = hmd.Num(), id2 = hmd.Omittable(hmd.Str())) => {
  },
  removeTimeout: (id2 = hmd.Str()) => {
  },
  sleep: (milliseconds = hmd.Num()) => {
  },
  nowMillis: () => hmd.Num(),
  offset: (ts = hmd.Num(), offset2 = hmd.Struct({
    years: hmd.Omittable(hmd.Num()),
    months: hmd.Omittable(hmd.Num()),
    days: hmd.Omittable(hmd.Num()),
    hours: hmd.Omittable(hmd.Num()),
    minutes: hmd.Omittable(hmd.Num()),
    seconds: hmd.Omittable(hmd.Num())
  }), timeZone = hmd.Omittable(hmd.Str())) => hmd.Num(),
  startOf: (ts = hmd.Num(), unit = hmd.Str(), timeZone = hmd.Omittable(hmd.Str())) => hmd.Num(),
  format: (ts = hmd.Num(), format = hmd.Str(), timeZone = hmd.Omittable(hmd.Str())) => hmd.Str()
});
var audienceDeclaration = {
  kind: "namespace",
  members: {}
};
var builtInHostModuleDeclarations = /* @__PURE__ */ new Map([
  ["time", timeDeclaration],
  ["audience", audienceDeclaration]
]);

// src/skill-tools/check-arc.ts
function checkArcSource(source) {
  let document;
  try {
    document = parse4(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, lines: [`parse error: ${message}`] };
  }
  const analysis = analyzeDocument(document, {
    hostModules: builtInHostModuleDeclarations
  });
  const lines = [];
  for (const issue2 of analysis.issues) {
    lines.push(`error ${issue2.code} ${position2(issue2.loc)}${issue2.message}`);
  }
  for (const lint of analysis.lintIssues) {
    lines.push(
      `${lint.severity} ${lint.code} ${position2(lint.loc)}${lint.message}`
    );
  }
  if (lines.length === 0) lines.push("no issues or lints");
  lines.push("", "outline:");
  for (const root of document.roots) lines.push(...outline(root, 1));
  return { ok: analysis.issues.length === 0, lines };
}
function position2(loc) {
  return loc ? `${loc.start.line}:${loc.start.column} ` : "";
}
function outline(node2, depth) {
  const parts = [node2.identifier];
  if (node2.displayName) parts.push(JSON.stringify(node2.displayName));
  const args = Object.keys(node2.signature?.args ?? {});
  const returns = Object.keys(node2.signature?.returns ?? {});
  if (args.length > 0) parts.push(`args(${args.join(", ")})`);
  if (returns.length > 0) parts.push(`returns(${returns.join(", ")})`);
  if (node2.statements.length === 0) parts.push("[empty]");
  return [
    `${"  ".repeat(depth)}${parts.join(" ")}`,
    ...node2.children.flatMap((child) => outline(child, depth + 1))
  ];
}

// src/skill-tools/check-arc-cli.ts
var files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write("usage: check-arc.mjs <file.arc.js>...\n");
  process.exit(2);
}
var ok = true;
for (const file of files) {
  const report = checkArcSource(readFileSync(file, "utf8"));
  ok &&= report.ok;
  process.stdout.write(`${file}
${report.lines.join("\n")}

`);
}
process.exit(ok ? 0 : 1);
