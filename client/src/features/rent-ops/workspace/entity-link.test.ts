import assert from 'node:assert/strict';
import test from 'node:test';
import {entityHref,shouldHandleEntityClick} from './entity-link';
import {parseWorkspaceFilters,parseWorkspaceRoute} from './workspace-state';

test('entity links contain exact targets and preserve the originating report filters for new tabs',()=>{
 const href=entityHref({section:'tenants',recordId:'person:future-12',tab:'ledger',report:'rent-roll'},'?ui=clean&section=reports&report=rent-roll&property=p1&property=p2&search=Smith&status=future&asOf=2026-10-01');
 assert.equal(parseWorkspaceRoute(href).recordId,'person:future-12');
 assert.equal(parseWorkspaceRoute(href).tab,'ledger');
 assert.deepEqual(parseWorkspaceFilters(href).propertyIds,['p1','p2']);
 assert.equal(parseWorkspaceFilters(href).search,'Smith');
 assert.equal(new URLSearchParams(href).get('ui'),'clean');
});
test('entity links handle ordinary activation but retain browser new-tab and modifier behavior',()=>{
 const ordinary={button:0,metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,defaultPrevented:false};
 assert.equal(shouldHandleEntityClick(ordinary),true);
 for(const modifier of ['metaKey','ctrlKey','shiftKey','altKey','defaultPrevented'])assert.equal(shouldHandleEntityClick({...ordinary,[modifier]:true}),false);
 assert.equal(shouldHandleEntityClick({...ordinary,button:1}),false);
});
