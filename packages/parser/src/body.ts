import { AttributeValue } from './ast';
import { Position } from './Position';

/** What a block holds, before anything knows which blocks there are: attributes and blocks, in the order written. */
export type Body = (Attribute | Block)[];

export interface Attribute {
  type: 'Attribute';
  name: string;
  value: AttributeValue;
  position: Position;
}

/** A label is written in quotes, and `position` is at its quote. */
export interface Label {
  value: string;
  position: Position;
}

/** A block's name and labels, read before its body. */
export interface Header {
  name: string;
  labels: Label[];
  position: Position;
  /** Where the `{` is, or was looked for. */
  open: Position;
}

export interface Block extends Header {
  type: 'Block';
  body: Body;
}

/** The block a part is written in, and what of that block's body is read before it. */
export interface Inside {
  block: Header;
  before: Body;
}

/** What the blocks mean, asked as each part is read so a mistake is named where it is; the parser itself knows no kind of block. */
export interface Schema {
  /** Left without `inside` at the top of the file, where it must refuse a header with no `{` after it, as the parser takes one there. */
  header(header: Header, opened: boolean, inside?: Inside): void;
  attribute(attribute: Attribute, inside: Inside): void;
  /** A block inside another, once its body is read. */
  closed(block: Block, inside: Inside): void;
}
