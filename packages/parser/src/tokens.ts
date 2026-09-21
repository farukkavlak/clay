import { Range } from './Range';

export enum TokenType {
  Identifier = 'IDENTIFIER', // Block kinds, attribute names, reference parts
  String = 'STRING', // "value"
  Number = 'NUMBER', // 123
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
  range: Range;
}
