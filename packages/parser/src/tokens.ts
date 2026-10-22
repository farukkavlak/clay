import { Position } from './Position';

export enum TokenType {
  Identifier = 'IDENTIFIER',
  OQuote = 'OQUOTE',
  QuotedLit = 'QUOTED_LIT', // escapes as written
  TemplateInterp = 'TEMPLATE_INTERP',
  TemplateEnd = 'TEMPLATE_END',
  CQuote = 'CQUOTE',
  OHeredoc = 'OHEREDOC',
  StringLit = 'STRING_LIT', // no escapes
  CHeredoc = 'CHEREDOC',
  Number = 'NUMBER',
  Minus = 'MINUS',
  Boolean = 'BOOLEAN',
  Null = 'NULL',
  LBrace = 'LBRACE',
  RBrace = 'RBRACE',
  Assign = 'ASSIGN',
  Dot = 'DOT',
  LBracket = 'LBRACKET',
  RBracket = 'RBRACKET',
  LParen = 'LPAREN',
  RParen = 'RPAREN',
  Comma = 'COMMA',
  Colon = 'COLON',
  FatArrow = 'FAT_ARROW',
  Ellipsis = 'ELLIPSIS',
  Equal = 'EQUAL',
  NotEqual = 'NOT_EQUAL',
  And = 'AND',
  Or = 'OR',
  Bang = 'BANG',
  Question = 'QUESTION',
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string;
  position: Position;
}
