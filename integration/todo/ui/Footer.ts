/**
 * @license
 * Copyright a-Qoot All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/a-Qoot/qoot/blob/main/LICENSE
 */

import { TodoEntity } from '../data/Todo.js';
import { jsxDeclareComponent, QRL, EntityKey } from '../qoot.js';

/**
 * @fileoverview
 *
 */

export interface FooterProps {
  $todos: EntityKey<TodoEntity>;
}

export const Footer = jsxDeclareComponent<FooterProps>(QRL`ui:/Footer_template`, 'footer');
