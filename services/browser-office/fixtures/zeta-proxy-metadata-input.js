// SPDX-License-Identifier: MIT
// Pinned ZetaJS proxy declaration walker, retained as test input only.
// Upstream source identity is admitted by server.mjs before transformation.
    function proxy(unoObject) {
        function walk(td) {
          const iname = td.getName();
          if (!Object.hasOwn(seen, iname)) {
            seen[iname] = true;
            if (td.getTypeClass() !== Module.uno.com.sun.star.uno.TypeClass.INTERFACE) {
              throw new Error('not a UNO interface type: ' + iname);
            }
            const itd = Module.uno.com.sun.star.reflection.XInterfaceTypeDescription2
                .query(td);
            const bases = itd.getBaseTypes();
            for (let i = 0; i !== bases.size(); ++i) {
              const base = bases.get(i);
              walk(base);
              base.delete();
            }
            bases.delete();
            const mems = itd.getMembers();
            for (let i = 0; i !== mems.size(); ++i) {
              const mem = mems.get(i);
              const name = mem.getMemberName();
              const atd = Module.uno.com.sun.star.reflection
                  .XInterfaceAttributeTypeDescription.query(mem);
              mem.delete();
              if (atd !== null) {
                Object.defineProperty(prox, name, {
                  enumerable: true,
                  get() { return invokeGetter(name, false); },
                  set: atd.isReadOnly()
                    ? undefined
                    : function(value) { return invokeSetter(name, value); }});
                Object.defineProperty(prox.$precise, name, {
                  enumerable: true,
                  get() { return invokeGetter(name, true); },
                  set: atd.isReadOnly()
                    ? undefined
                    : function(value) { return invokeSetter(name, value); }});
                atd.delete();
              } else {
                prox[name] = function() { return invokeMethod(name, arguments, false); };
                prox.$precise[name] = function() { return invokeMethod(name, arguments, true); };
              }
            }
            itd.delete();
            mems.delete();
            if (iname === 'com.sun.star.container.XEnumeration') {
              prox[Symbol.iterator] = function*() {
                while (prox.hasMoreElements()) {
                  yield prox.nextElement();
                }
              }
              prox.$precise[Symbol.iterator] = function*() {
                while (prox.$precise.hasMoreElements()) {
                  yield prox.$precise.nextElement();
                }
              }
            }
          }
        };
        const tdm = getTypeDescriptionManager();
    };
