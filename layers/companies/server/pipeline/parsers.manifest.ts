// The companies layer's DETERMINISTIC parsers, imported for their side-effect
// registration; the shell's parsers.manifest.ts imports this file, and the
// determinism test iterates the registry the manifests fill.
// EDGAR
import './parsers/sec/edgar-fts'
import './parsers/sec/edgar-submissions'
import './parsers/sec/edgar-companyfacts'
import './parsers/sec/xbrl-segment'
import './parsers/sec/filing-index'
import './parsers/sec/prospectus-revenue'
import './parsers/sec/prospectus'
