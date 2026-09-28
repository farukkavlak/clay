import { Position } from './Position';

export enum TokenType {
  Identifier = 'IDENTIFIER', // Block kinds, attribute names, reference parts
  OQuote = 'OQUOTE',
  QuotedLit = 'QUOTED_LIT', // escapes as written
  TemplateInterp = 'TEMPLATE_INTERP',
  TemplateEnd = 'TEMPLATE_END',
  CQuote = 'CQUOTE',
  Number = 'NUMBER', // 123, 1.5, 1e3
  Minus = 'MINUS', // - (before a number)
  Boolean = 'BOOLEAN', // true, false
  LBrace = 'LBRACE', // {
  RBrace = 'RBRACE', // }
  Assign = 'ASSIGN', // =
  Dot = 'DOT', // . (for references)
  LBracket = 'LBRACKET', // [
  RBracket = 'RBRACKET', // ]
  Comma = 'COMMA', // ,
  EOF = 'EOF', // End of File
}

export interface Token {
  type: TokenType;
  value: string;
  position: Position;
}
