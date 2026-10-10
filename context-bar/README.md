# context-bar

Shows the context window above the prompt as a stacked bar, one colour per category (system prompt, tools, messages, free space and so on), with the percentage used and `used/max` at its right end. A legend names the categories. The bar updates after each reply and after `/compact`.

With [context-diet](../context-diet/) loaded, another line shows the three biggest items in context and the tokens saved by output cleanup.

Requires [modbar](../modbar/), which draws it.

## Commands

context-bar has no command of its own. Use modbar's:

- `/modbar hide context-bar` hides the bar and legend; `/modbar show context-bar` brings them back.
- `/modbar hide context-bar.legend` hides only the legend.
