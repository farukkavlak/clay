import { Position } from './Position';

export enum TokenType {
  Identifier = 'IDENTIFIER', // Block kinds, attribute names, reference parts
  String = 'STRING', // "value"
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
