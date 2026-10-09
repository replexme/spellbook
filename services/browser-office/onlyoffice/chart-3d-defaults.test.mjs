import test from 'node:test';
import assert from 'node:assert/strict';
import {installOnlyOfficeChart3dDefaults} from './chart-3d-defaults.mjs';
function fixture(run) {
  const prior={window:globalThis.window,AscFormat:globalThis.AscFormat,AscDFH:globalThis.AscDFH};
  class Chart {constructor(view,type=3,b3D=true){this.view3D=view;this.plotArea={charts:[{b3D,getObjectType:()=>type}]};}getView3d(){return this.view3D?{...this.view3D,rotX:this.view3D.rotX??0,rotY:this.view3D.rotY??0}:null;}}
  globalThis.window={};globalThis.AscFormat={CChart:Chart,isRealNumber:n=>typeof n==='number'&&Number.isFinite(n)};globalThis.AscDFH={historyitem_type_BarChart:3};
  try{return run(Chart);}finally{for(const[k,v]of Object.entries(prior))globalThis[k]=v;}
}
test('omitted bar angles match PowerPoint while authored XML state remains unchanged',()=>fixture(Chart=>{
  const authored={rotX:null,rotY:null,perspective:30},chart=new Chart(authored);installOnlyOfficeChart3dDefaults();
  assert.deepEqual(chart.getView3d(),{rotX:15,rotY:20,perspective:30});assert.deepEqual(authored,{rotX:null,rotY:null,perspective:30});
  const first=chart.getView3d();first.rotX=90;assert.equal(chart.getView3d().rotX,15);
}));
test('explicit zero and mixed explicit/default angles are preserved independently',()=>fixture(Chart=>{
  installOnlyOfficeChart3dDefaults();assert.deepEqual(new Chart({rotX:0,rotY:0}).getView3d(),{rotX:0,rotY:0});
  assert.deepEqual(new Chart({rotX:0,rotY:null}).getView3d(),{rotX:0,rotY:20});
  assert.deepEqual(new Chart({rotX:27,rotY:310}).getView3d(),{rotX:27,rotY:310});
}));
test('other chart defaults and missing scenes retain native behavior; install is idempotent',()=>fixture(Chart=>{
  const other=new Chart({rotX:null,rotY:null},9),expected=other.getView3d();installOnlyOfficeChart3dDefaults();const wrapped=Chart.prototype.getView3d;installOnlyOfficeChart3dDefaults();
  assert.equal(Chart.prototype.getView3d,wrapped);assert.deepEqual(other.getView3d(),expected);assert.equal(new Chart(null).getView3d(),null);
}));
test('native boundary mismatch fails before changing a chart method',()=>fixture(Chart=>{
  const method=Chart.prototype.getView3d;delete AscFormat.isRealNumber;assert.throws(installOnlyOfficeChart3dDefaults,/native_boundary_missing/);assert.equal(Chart.prototype.getView3d,method);
}));

test('2D bars with unused view metadata retain the native result',()=>fixture(Chart=>{const chart=new Chart({rotX:null,rotY:null},3,false),expected=chart.getView3d();installOnlyOfficeChart3dDefaults();assert.deepEqual(chart.getView3d(),expected);}));
