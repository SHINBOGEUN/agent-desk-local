import { edit } from '../_shared/edit.mjs';

export function apply(directory) {
  edit(directory, 'src/app.mjs', "if (status) todos = todos.filter(todo => todo.done === status);", "if (status) todos = todos.filter(todo => todo.done === (status === 'done'));");
}
