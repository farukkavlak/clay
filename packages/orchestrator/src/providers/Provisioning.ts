import { AttributePath } from '@clay/contracts';
import { ProvisionerBlock } from '@clay/parser';

import { conformed, SchemaMismatch } from '../values/conformValues';
import { asError } from '../asError';
import { Context } from '../keys';
import { hidingReason } from './providerResult';
import { Limit } from './Limit';
import { marksOf } from '../values/schemaMarks';
import { plainOf, Value } from '../values/Value';
import { ProvisionerRegistry } from './ProvisionerRegistry';
import { withPlace } from '../place';

/** What a provisioner is given, as it receives it, and the steps to each sensitive part. */
export interface ProvisionerConfig {
  config: Record<string, unknown>;
  sensitive: AttributePath[];
}

/** Checks what a provisioner block gives, at plan with what is known and at apply with every value, and runs it on an object once it is made. */
export class Provisioning {
  constructor(
    private provisioners: ProvisionerRegistry,
    private limit: Limit
  ) {}

  /** `declaration` names the resource block it is written in. A problem is placed where it is written. */
  async check(
    { provisionerType: { value: type }, attributes, position }: ProvisionerBlock,
    given: Record<string, Value>,
    declaration: string,
    at: Context
  ): Promise<ProvisionerConfig> {
    try {
      const schema = await this.limit.run(() => this.provisioners.schema(type));
      const values = conformed(type, schema, given);
      const config = plainOf(values);
      const sensitive = marksOf(schema, values);
      await this.limit.run(() => hidingReason(type, sensitive, () => this.provisioners.get(type).validate(config)));
      return { config, sensitive };
    } catch (error) {
      const written = error instanceof SchemaMismatch && error.attribute !== undefined ? attributes[error.attribute].position : position;
      throw withPlace(error, written, declaration, at);
    }
  }

  /** The reason is hidden where a value given is sensitive. */
  async run(type: string, { config, sensitive }: ProvisionerConfig): Promise<void> {
    const provisioner = this.provisioners.get(type);

    await hidingReason(
      type,
      sensitive,
      () =>
        this.limit.run(async () => {
          try {
            await provisioner.run(config);
          } catch (error) {
            // Whatever it throws, the step failed, and the message says which one.
            throw new Error(`${type} failed: ${asError(error).message}`, { cause: error });
          }
        }),
      'to run'
    );
  }
}
