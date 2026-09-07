execute `moth show` and if there's a current task, start implementing it.

use IDEA.md and README.md for global context, us  `moth ls` and `moth show <id>` to view tasks in "done" status for context and past decisions. 

ask questions as needed. during the session update the existing md under ./moth/doing with information
relevant to feature specification, including decisions taken and rejected. the information in the md should be enough to recreate the feature from the scratch. Under implementation details, don't describe the resulting code changes, only an abstract of how it's done.

use specifications under ./moth/done/ to ensure decision consistency

only expand and correct feature specification, never change it to a different one. e.g. for example if we're implementing addition and there's a request to add logging, the specification should decribe both addition and logging.

use `moth update` to update the task specification. keep the original, modify a section under the orginal demarkated by `----- AI agent updates -------`

always allow `moth show`, `moth ls`, `moth update`, all `npm` and all `cargo` executions.
never run `moth done`.
never run `moth start`.

you never decide when the task is done.
