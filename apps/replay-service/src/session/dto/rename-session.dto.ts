import { ValidateBy, ValidationOptions } from 'class-validator';
import { normalizeTitle } from '../title';

// A title by normalizeTitle's rules (title.ts); with `required`, the property must be
// present (null clears the title)
export function IsReplayTitle(required: boolean, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy({
    name: 'isReplayTitle',
    validator: {
      validate: (value: unknown) => (value === undefined ? !required : normalizeTitle(value).error === null),
      defaultMessage: (args) => {
        if (args?.value === undefined) return 'title is required (null clears it)';
        return normalizeTitle(args?.value).error ?? 'title is invalid';
      },
    },
  }, options);
}

export class RenameSessionDto {
  // 1-60 characters after trimming; '' or null gives the session its auto name
  @IsReplayTitle(true)
  title!: string | null;
}
