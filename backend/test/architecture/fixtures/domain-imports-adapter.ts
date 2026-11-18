/**
 * Intentional architecture violation used by dependency-cruise negative proof.
 * Not imported by the app; cruised only from the architecture test.
 */
import { withOwner } from "../../../src/adapters/db-postgres/with-owner.js";

export const leak = withOwner;
