Rendering reference
===================

This page is reStructuredText, rendered by the pinned Docutils helper into the
same closed intermediate representation Markdown produces.

Structure
---------

A section title becomes a heading with a stable anchor, exactly as in Markdown.

.. note::

   Docutils' own admonitions land on the portal's vocabulary, and the authored
   word survives as the title.

.. tip::

   A tip.

.. warning::

   A warning.

.. caution::

   Docutils calls this its own class; the portal draws it as a warning.

.. danger::

   A danger block.

.. hint::

   A hint, drawn as a tip.

.. seealso::

   Sphinx's own directive, accepted here and titled "See also".

Code
----

.. code:: python

   print("rendered at build time")

Mathematics
-----------

.. math::

   a^2 + b^2 = c^2

Lists
-----

* one
* two

A link back to the `guide </docs/guide/>`_ and to `the documentation index
</docs/>`_.
