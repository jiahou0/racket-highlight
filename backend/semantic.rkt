#lang racket/base

(require racket/class racket/list racket/match racket/path racket/port racket/string racket/keyword-transform
         drracket/check-syntax scribble/blueboxes syntax/modresolve syntax/kerncase syntax/id-table "common.rkt")
(provide main)

(define collector%
  (class (annotations-mixin object%)
    (super-new)
    (define annotations '())
    (define callbacks (make-hash))
    (define documentation (make-hash))
    (define identifiers (make-hash))
    (define next-id 0)
    (define/private (fresh-id) (set! next-id (add1 next-id)) next-id)
    (define/private (add kind . fields)
      (set! annotations (cons (apply hasheq 'kind kind fields) annotations)))
    (define/private (phases-at at)
      (remove-duplicates
       (append
        (for/list ([edge (in-list annotations)]
                   #:when (and (equal? (hash-ref edge 'kind) "binding") (hash-ref edge 'actual)
                               (equal? (hash-ref (hash-ref edge 'to) 'source) (hash-ref at 'source))
                               (<= (hash-ref at 'start) (hash-ref (hash-ref edge 'to) 'start))
                               (<= (hash-ref (hash-ref edge 'to) 'end) (hash-ref at 'end))))
          (hash-ref edge 'phase))
        (for/list ([definition (in-list annotations)]
                   #:when (and (equal? (hash-ref definition 'kind) "definition")
                               (equal? (hash-ref definition 'at) at)))
          (binding-phase (hash-ref definition 'phaseSpace))))))
    (define/public (all)
      (for/list ([annotation (in-list (reverse annotations))])
        (cond
          [(equal? (hash-ref annotation 'kind) "jump")
           (define at (hash-ref annotation 'at))
           (define levels (phases-at at))
           (define phases
             (remove-duplicates
              (for*/list ([id (in-list (hash-ref identifiers at '()))] [phase (in-list levels)]
                          [binding (in-value (identifier-binding id phase))]
                          #:when (binding-matches-jump? binding annotation))
                (list-ref binding 4))))
           (hash-set annotation 'definitionPhases phases)]
          [else annotation])))
    (define/public (check-name ids name)
      (for/list ([id (in-list ids)] #:when ((hash-ref callbacks id) name)) id))
    (define/public (doc id) (hash-ref documentation id))
    (define/public (add-literal-kinds locations)
      (for ([at (in-list (remove-duplicates locations))])
        (add "identifierKind" 'at at 'type "datum")))
    (define/public (add-applications applications)
      (for ([application (in-list (remove-duplicates applications))])
        (add "application" 'at (car application) 'operatorAt (cdr application))))
    (define/public (add-source-details details)
      (set! annotations (append (reverse details) annotations)))
    (define/public (add-macro-kinds candidates)
      (define macros (make-hasheq))
      (for ([c (in-list candidates)] #:when (equal? (candidate-kind c) "macro"))
        (hash-update! macros (syntax-e (candidate-identifier c)) (lambda (items) (cons c items)) '()))
      (define seen (make-hash))
      (for ([a (in-list annotations)] #:when (equal? (hash-ref a 'kind) "style"))
        (define at (hash-ref a 'at))
        (when (and (not (hash-has-key? seen at))
                   (for*/or ([id (in-list (hash-ref identifiers at '()))]
                             [c (in-list (hash-ref macros (syntax-e id) '()))])
                     (define phase (candidate-phase c))
                     (and (member phase (phases-at at))
                          (identifier-binding (candidate-identifier c) phase)
                          (free-identifier=? id (candidate-identifier c) phase))))
          (hash-set! seen at #t)
          (add "identifierKind" 'at at 'type "macro"))))
    (define/override (syncheck:find-source-object stx)
      (when (identifier? stx)
        (define at (syntax-location stx))
        (when at (hash-update! identifiers at (lambda (ids) (cons stx ids)) '())))
      (source-name (syntax-source stx)))
    (define/override (syncheck:add-text-type source start end type)
      (add "textType" 'at (location source start end) 'type (json-value type)))
    (define/override (syncheck:color-range source start end style)
      (add "style" 'at (location source start end) 'style (json-value style)))
    (define/override (syncheck:add-require-open-menu source start end path)
      (add "require" 'at (location source start end) 'path (canonical path)))
    (define/override (syncheck:add-docs-menu source start end id label path definition-tag tag)
      (define key (fresh-id))
      (hash-set! documentation key definition-tag)
      (add "documentation" 'at (location source start end) 'id key 'name (json-value id)
           'label (format "~a" label) 'path (json-value path) 'tag (json-value tag)
           'definitionTag (json-value definition-tag)))
    (define/override (syncheck:add-arrow/name-dup/pxpy from start end px py to left right tx ty actual? phase require? duplicate?)
      (define id (fresh-id))
      (hash-set! callbacks id duplicate?)
      (add "binding" 'from (location from start end) 'to (location to left right)
           'fromAnchor (list px py) 'toAnchor (list tx ty) 'actual actual?
           'phase (json-value phase) 'require (json-value require?) 'id id))
    (define/override (syncheck:add-tail-arrow source from target to)
      (add "tail" 'from (location source from from) 'to (location target to to)))
    (define/override (syncheck:add-mouse-over-status source start end text)
      (add "hover" 'at (location source start end) 'text text))
    (define/override (syncheck:add-jump-to-definition/phase-level+space source start end id path submods phase-space)
      (add "jump" 'at (location source start end) 'name (json-value id) 'path (canonical path)
           'submodules (json-value submods) 'phaseSpace (json-value phase-space)))
    (define/override (syncheck:add-definition-target/phase-level+space source start end id submods phase-space)
      (add "definition" 'at (location source start end) 'name (json-value id)
           'submodules (json-value submods) 'phaseSpace (json-value phase-space)))
    (define/override (syncheck:unused-binder source start end)
      (add "unusedBinding" 'at (location source start end)))
    (define/override (syncheck:add-unused-require source start end)
      (add "unusedRequire" 'at (location source start end)))
    (define/override (syncheck:add-prefixed-require-reference source start end prefix prefix-source left right)
      (add "prefix" 'at (location source start end) 'prefix (json-value prefix)
           'prefixAt (and prefix-source left right (location prefix-source left right))))))

(struct candidate (identifier phase space kind origin) #:transparent)
(struct context (syntax phase start end) #:transparent)
(struct model (candidates bindings contexts imports issues literals quoted applications details exports exports-complete?) #:transparent)

(define (candidates-for-binding bindings id phase)
  (define table (hash-ref bindings phase #f))
  (if table (free-id-table-ref table id '()) '()))

;; Equal printed names do not identify an imported binding. Compare the actual
;; defining module and submodule as well as the name reported by Check Syntax.
(define (binding-matches-jump? binding annotation)
  (and (list? binding) (= (length binding) 7)
       (equal? (symbol->string (second binding)) (hash-ref annotation 'name))
       (with-handlers ([exn:fail? (lambda (_) #f)])
         (define resolved (resolved-module-path-name (module-path-index-resolve (first binding))))
         (define path (if (pair? resolved) (car resolved) resolved))
         (define submodules (if (pair? resolved) (cdr resolved) '()))
         (and (path? path) (equal? (canonical path) (hash-ref annotation 'path))
              (equal? (json-value submodules) (hash-ref annotation 'submodules))))))

(define (binding-space phase-space) (and (pair? phase-space) (cdr phase-space)))
(define (binding-phase phase-space)
  (cond [(pair? phase-space) (car phase-space)]
        [(hash? phase-space) (hash-ref phase-space 'car)]
        [else phase-space]))
(define (phase+ a b) (and a b (+ a b)))

;; Import names come from declared modules. This does not instantiate the
;; user's module, or evaluate its run-time expressions for completion.
(define (build-model original expanded path)
  (define candidates '())
  (define contexts '())
  (define imports '())
  (define issues '())
  (define literals '())
  (define quoted '())
  (define applications '())
  (define call-identifiers '())
  (define details '())
  (define exports '())
  (define exports-complete? #t)
  (define source-identifiers (make-hash))
  (define source-applications (make-hash))
  (define parameter-locations (make-hash))
  (define retained-origins '())
  (define (collect-source-identifiers value)
    (cond
      [(identifier? value)
       (define at (syntax-location value))
       (when (and at (syntax-original? value) (equal? (hash-ref at 'source) path))
         (hash-set! source-identifiers at (syntax-e value)))]
      [(syntax? value)
       (define parts (syntax->list value))
       (when (and (pair? parts) (identifier? (car parts)))
         (define at (syntax-location (car parts)))
         (when at (hash-set! source-applications at parts)))
       (collect-source-identifiers (syntax-e value))]
      [(pair? value) (collect-source-identifiers (car value)) (collect-source-identifiers (cdr value))]
      [(vector? value) (for ([v (in-vector value)]) (collect-source-identifiers v))]
      [(box? value) (collect-source-identifiers (unbox value))]))
  (collect-source-identifiers original)
  (define (record-parameters formals phase)
    (cond
      [(identifier? formals)
       (define at (syntax-location formals))
       (when at (hash-set! parameter-locations (cons at phase) (syntax-e formals)))]
      [(syntax? formals) (record-parameters (syntax-e formals) phase)]
      [(pair? formals)
       (define arg (car formals))
       (define optional (and (syntax? arg) (syntax->list arg)))
       (record-parameters (if (and optional (= (length optional) 2)) (car optional) arg) phase)
       (record-parameters (cdr formals) phase)]))
  (define source-forms
    (list (cons #'define "define") (cons #'define-values "define-values")
          (cons #'define-syntax "define-syntax") (cons #'define-syntaxes "define-syntaxes")
          (cons #'define-syntax-rule "define-syntax-rule")
          (cons #'lambda "lambda") (cons #'λ "lambda")
          (cons #'case-lambda "case-lambda")
          (cons #'module "module") (cons #'module* "module*") (cons #'module+ "module+")
          (cons #'struct "struct") (cons #'define-struct "define-struct")))
  (define (source-origin value phase)
    (cond
      [(identifier? value)
       (define at (syntax-location value))
       ;; Expansion can leave macro scopes on a source origin, making
       ;; syntax-original? false. Match the reader's exact range and name,
       ;; then confirm the binding before recognizing a source form.
       (when (and at (eq? (hash-ref source-identifiers at #f) (syntax-e value)))
         (unless (syntax-original? value)
           (set! retained-origins (cons (cons value phase) retained-origins)))
         (for ([entry (in-list source-forms)]
               #:when (free-identifier=? value (car entry) phase 0))
           (set! details (cons (hasheq 'kind "sourceForm" 'at at 'form (cdr entry)) details))
           (define parts (hash-ref source-applications at '()))
           (when (>= (length parts) 2)
             (cond
               [(equal? (cdr entry) "lambda") (record-parameters (second parts) phase)]
               [(equal? (cdr entry) "case-lambda")
                (for ([clause (in-list (cdr parts))])
                  (define body (syntax->list clause))
                  (when (pair? body) (record-parameters (car body) phase)))]
               [(equal? (cdr entry) "define")
                (let loop ([header (second parts)])
                  (when (and (syntax? header) (pair? (syntax-e header)))
                    (define header-pair (syntax-e header))
                    (record-parameters (cdr header-pair) phase)
                    (loop (car header-pair))))]))))]
      [(pair? value) (source-origin (car value) phase) (source-origin (cdr value) phase)]))
  (define (definition-detail id form phase kind)
    (define at (syntax-location id))
    (define span (syntax-location form))
    (when (and at span (identifier? id) (syntax-original? id)
               (equal? (hash-ref at 'source) path) (equal? (hash-ref span 'source) path)
               (<= (hash-ref span 'start) (hash-ref at 'start) (hash-ref at 'end) (hash-ref span 'end)))
      (set! details (cons (hasheq 'kind "outline" 'at at 'span span
                                  'name (symbol->string (syntax-e id))
                                  'symbolKind kind 'phaseSpace (json-value phase)) details))))
  (define (lambda-expression? stx phase)
    (kernel-syntax-case/phase stx phase
      [(#%plain-lambda . _) #t]
      [(case-lambda . _) #t]
      [_ #f]))
  (define (value-binding-kind ids rhs phase)
    (define names (syntax->list ids))
    (cond
      [(and names (= (length names) 1) (lambda-expression? rhs phase))
       (define id (car names))
       (define at (syntax-location id))
       (when (and at (identifier? id)
                  (eq? (hash-ref source-identifiers at #f) (syntax-e id)))
         (set! details (cons (hasheq 'kind "identifierKind" 'at at 'type "function") details)))
       "function"]
      [else "variable"]))
  (define (application-operators operator phase)
    ;; Optional/keyword procedures can expand into calls to hidden procedures.
    ;; Racket publishes the original identifier through these official APIs.
    (define (originals value)
      (cond
        [(and (pair? value) (identifier? (car value)) (identifier? (cdr value)))
         (if (free-identifier=? operator (cdr value) phase) (list (car value)) '())]
        [(pair? value) (append (originals (car value)) (originals (cdr value)))]
        [else '()]))
    (append (if (and (identifier? operator) (syntax-original? operator)) (list operator) '())
            (originals (syntax-procedure-alias-property operator))
            (originals (syntax-procedure-converted-arguments-property operator))))
  ;; Expanded quote operands retain the reader's symbol locations. Quasiquote
  ;; expansion already separates literal pieces from active unquote expressions,
  ;; including nested quotes; no source-level quote-depth heuristic is needed.
  (define (collect-literals value)
    (cond
      [(identifier? value)
       (define at (syntax-location value))
       (when (and at (equal? (hash-ref at 'source) path)
                  (or (syntax-original? value) (syntax-property value 'original-for-check-syntax)))
         (set! literals (cons at literals)))]
      [(syntax? value) (collect-literals (syntax-e value))]
      [(pair? value) (collect-literals (car value)) (collect-literals (cdr value))]
      [(vector? value) (for ([v (in-vector value)]) (collect-literals v))]
      [(box? value) (collect-literals (unbox value))]
      [(hash? value) (for ([(k v) (in-hash value)]) (collect-literals k) (collect-literals v))]
      [(prefab-struct-key value) (collect-literals (struct->vector value))]))
  (define (import-spec spec phase [only-phase 'all] [space #f] [only-space 'all])
    (define datum (syntax->datum spec))
    (define parts (syntax->list spec))
    (define (recur xs p [op only-phase] [s space] [os only-space])
      (for ([x (in-list xs)]) (import-spec x p op s os)))
    (define (exports module-path prefix only except renamed [local-at #f] [original-at #f])
      (with-handlers ([exn:fail? (lambda (e) (set! issues (cons (exn-message e) issues)))])
        (define resolved (resolve-module-path module-path (string->path path)))
        (define-values (variables syntax-exports) (module->exports resolved))
        (for ([groups (in-list (list variables syntax-exports))] [kind (in-list '("variable" "macro"))])
          (for* ([group (in-list groups)] [export (in-list (cdr group))])
            (define phase-space (car group))
            (define export-phase (binding-phase phase-space))
            (define export-space (binding-space phase-space))
            (define original (car export))
            (when (and (or (eq? only-phase 'all) (equal? only-phase export-phase))
                       (or (eq? only-space 'all) (equal? only-space export-space))
                       (or (not only) (member original only)) (not (member original except)))
              (define name (or renamed (string->symbol (string-append prefix (symbol->string original)))))
              (define actual-space (or space export-space))
              ;; Import candidates carry scope, not a definition at the require site.
              (define id (datum->syntax spec name #f spec))
              (define scoped (if actual-space ((make-interned-syntax-introducer actual-space) id 'add) id))
              (define p (phase+ phase export-phase))
              (define binding (identifier-binding scoped p))
              (when (and (list? binding)
                         (equal? (resolve-module-path-index (third binding) (string->path path)) resolved)
                         (equal? (fourth binding) original)
                         (equal? (list-ref binding 6) phase-space))
                (set! candidates (cons (candidate scoped p actual-space kind (format "~s" module-path)) candidates)))
              (set! imports (cons (hasheq 'name (symbol->string name) 'original (symbol->string original)
                                         'renamed (and renamed #t) 'prefix prefix 'phase (json-value p)
                                         'space (json-value actual-space) 'module (format "~s" module-path)
                                         'localAt local-at 'originalAt original-at
                                         'at (syntax-location spec)) imports)))))))
    (match datum
      [(list 'for-meta p _ ...) (recur (cddr parts) (phase+ phase p))]
      [(list 'for-syntax _ ...) (recur (cdr parts) (phase+ phase 1))]
      [(list 'for-template _ ...) (recur (cdr parts) (phase+ phase -1))]
      [(list 'for-label _ ...) (recur (cdr parts) #f)]
      [(list 'just-meta p _ ...) (recur (cddr parts) phase p)]
      [(list 'for-space s _ ...) (recur (cddr parts) phase only-phase s)]
      [(list 'just-space s _ ...) (recur (cddr parts) phase only-phase space s)]
      [(list 'portal _ _) (void)]
      [(list 'only mp ids ...) (exports mp "" ids '() #f)]
      [(list 'all-except mp ids ...) (exports mp "" #f ids #f)]
      [(list 'prefix prefix mp) (exports mp (symbol->string prefix) #f '() #f)]
      [(list 'prefix-all-except prefix mp ids ...) (exports mp (symbol->string prefix) #f ids #f)]
      [(list 'rename mp local original)
       (exports mp "" (list original) '() local (syntax-location (third parts)) (syntax-location (fourth parts)))]
      [_ (when (module-path? datum) (exports datum "" #f '() #f))]))
  ;; Only proven private definitions may bypass workspace-wide rename. Unknown
  ;; primitive provide forms keep the existing conservative cross-file path.
  (define (export-spec spec phase [space #f])
    (define parts (syntax->list spec))
    (define (export-id id [external id])
      ;; Generated export names can depend on private source names (contracts,
      ;; prefixes, custom provide transformers). Do not infer a local-only edit.
      (unless (and (syntax-original? id) (syntax-original? external))
        (set! exports-complete? #f))
      (define scoped (if space ((make-interned-syntax-introducer space) id 'add) id))
      (set! exports (cons (cons scoped phase) exports)))
    (define (recur specs p [s space])
      (for ([item (in-list specs)]) (export-spec item p s)))
    (cond
      [(identifier? spec) (export-id spec)]
      [else
       (match (syntax->datum spec)
         [(list 'rename _ _) (export-id (second parts) (third parts))]
         [(list 'protect _ ...) (recur (cdr parts) phase)]
         [(list 'for-meta p _ ...) (recur (cddr parts) (phase+ phase p))]
         [(list 'for-syntax _ ...) (recur (cdr parts) (phase+ phase 1))]
         [(list 'for-label _ ...) (recur (cdr parts) #f)]
         [(list 'for-space s _ ...) (recur (cddr parts) phase s)]
         [_ (set! exports-complete? #f)])]))
  (define (walk-value-binders bindings phase)
    (for ([clause (in-list (syntax->list bindings))])
      (define parts (syntax->list clause))
      (define ids (first parts))
      ;; Internal definitions retain their origin on the binding clause.
      (source-origin (syntax-property clause 'origin) phase)
      (walk ids phase (value-binding-kind ids (second parts) phase))))
  (define (walk value phase [kind "identifier"])
    (cond
      [(syntax? value)
       (source-origin (syntax-property value 'origin) phase)
       (when (pair? (syntax-e value)) (source-origin (car (syntax-e value)) phase))
       (define loc (syntax-location value))
       (when (and loc (equal? (hash-ref loc 'source) path))
         (set! contexts (cons (context value phase (hash-ref loc 'start) (hash-ref loc 'end)) contexts)))
       (cond
         [(identifier? value)
          (when (or (syntax-original? value) (syntax-property value 'original-for-check-syntax))
            (set! candidates (cons (candidate value phase #f kind "") candidates)))]
         [else
          (kernel-syntax-case/phase value phase
            [(module name lang body ...)
             (let ()
               (definition-detail #'name value phase "module")
               (import-spec (datum->syntax (car (syntax->list #'(body ...))) (syntax->datum #'lang) #'lang #'lang) 0)
               (for ([body (in-list (syntax->list #'(body ...)))]) (walk body 0)))]
            [(module* name lang body ...)
             (let ([nested-phase (if (syntax-e #'lang) 0 phase)])
               (definition-detail #'name value phase "module")
               (when (syntax-e #'lang)
                 (import-spec (datum->syntax (car (syntax->list #'(body ...))) (syntax->datum #'lang) #'lang #'lang) 0))
               (for ([body (in-list (syntax->list #'(body ...)))]) (walk body nested-phase)))]
            [(#%require spec ...) (for ([spec (in-list (syntax->list #'(spec ...)))]) (import-spec spec phase))]
            [(#%provide spec ...)
             (begin
               (for ([spec (in-list (syntax->list #'(spec ...)))]) (export-spec spec phase))
               (walk (syntax-e value) phase kind))]
            [(begin-for-syntax body ...) (for ([body (in-list (syntax->list #'(body ...)))]) (walk body (phase+ phase 1)))]
            [(define-syntaxes ids rhs)
             (begin
               (for ([id (in-list (syntax->list #'ids))]) (definition-detail id value phase "macro"))
               (walk #'ids phase "macro") (walk #'rhs (phase+ phase 1)))]
            [(define-values ids rhs)
             (let ([kind (value-binding-kind #'ids #'rhs phase)])
               (for ([id (in-list (syntax->list #'ids))])
                 (definition-detail id value phase kind))
               (walk #'ids phase kind) (walk #'rhs phase))]
            [(#%plain-lambda ids body ...)
             (begin (walk #'ids phase "variable") (walk #'(body ...) phase))]
            [(case-lambda (ids body ...) ...)
             (begin (for ([ids (in-list (syntax->list #'(ids ...)))]) (walk ids phase "variable"))
                    (walk #'((body ...) ...) phase))]
            [(let-values ([ids rhs] ...) body ...)
             (begin (walk-value-binders (second (syntax->list value)) phase)
                    (walk #'(rhs ... body ...) phase))]
            [(letrec-values ([ids rhs] ...) body ...)
             (begin (walk-value-binders (second (syntax->list value)) phase)
                    (walk #'(rhs ... body ...) phase))]
            [(quote datum)
             (let ([at (syntax-location #'datum)])
               (when (and at (equal? (hash-ref at 'source) path) (syntax-original? #'datum))
                 (set! quoted (cons at quoted)))
               (collect-literals #'datum))]
            [(quote-syntax . _) (void)]
            [(#%plain-app operator arg ...)
             (let ([at (syntax-location value)])
               (when (and at (identifier? #'operator) (equal? (hash-ref at 'source) path))
                 (for ([operator (in-list (application-operators #'operator phase))])
                   (define operator-at (syntax-location operator))
                   (when (and operator-at (equal? (hash-ref operator-at 'source) path)
                              (<= (hash-ref at 'start) (hash-ref operator-at 'start)
                                  (hash-ref operator-at 'end) (hash-ref at 'end)))
                     (set! applications (cons (cons at operator-at) applications))
                     (set! call-identifiers (cons (cons operator phase) call-identifiers)))))
               (walk #'(operator arg ...) phase))]
            [_ (walk (syntax-e value) phase kind)])])]
      [(pair? value) (walk (car value) phase kind) (walk (cdr value) phase kind)]
      [(vector? value) (for ([v (in-vector value)]) (walk v phase kind))]
      [(box? value) (walk (unbox value) phase kind)]))
  (walk expanded 0)
  ;; Index actual bindings, not printed names: import aliases can have different
  ;; spellings while denoting the same binding. Each phase needs its own table.
  (define bindings (make-hash))
  (for ([c (in-list candidates)] #:unless (equal? (candidate-kind c) "identifier"))
    (define phase (candidate-phase c))
    (define table (hash-ref! bindings phase (lambda () (make-free-id-table #:phase phase))))
    (free-id-table-update! table (candidate-identifier c) (lambda (items) (cons c items)) '()))
  ;; Optional and keyword parameters can become let bindings during expansion.
  ;; Match source formals to real expanded binders instead of relying on their
  ;; final position in a core lambda's argument list.
  (for ([c (in-list candidates)] #:when (equal? (candidate-kind c) "variable"))
    (define id (candidate-identifier c))
    (define at (syntax-location id))
    (when (and at (eq? (hash-ref parameter-locations (cons at (candidate-phase c)) #f) (syntax-e id)))
      (set! details (cons (hasheq 'kind "identifierKind" 'at at 'type "parameter") details))))
  (for* ([origin (in-list (remove-duplicates retained-origins))]
         [c (in-list (candidates-for-binding bindings (car origin) (cdr origin)))]
         #:when (and (equal? (candidate-kind c) "macro")
                     (identifier-binding (candidate-identifier c) (cdr origin))))
    (set! details (cons (hasheq 'kind "identifierKind" 'at (syntax-location (car origin))
                               'type "macro") details)))
  (for* ([call (in-list call-identifiers)]
         [c (in-list (candidates-for-binding bindings (car call) (cdr call)))]
         #:when (equal? (candidate-origin c) ""))
    (define target (syntax-location (candidate-identifier c)))
    (when (and target (equal? (hash-ref target 'source) path))
      (set! details (cons (hasheq 'kind "callBinding" 'at (syntax-location (car call))
                                  'definitionAt target) details))))
  (model candidates bindings contexts (reverse imports) (reverse issues) (reverse literals) quoted applications
         (remove-duplicates (reverse details)) exports exports-complete?))

(define current-env #f)
(define current-collector #f)
(define current-model #f)
(define current-mode "module")
(define complete? #f)
(define boxes (make-blueboxes-cache #f))

(define (private-definition? params)
  (and complete? current-model (model-exports-complete? current-model)
       (let ([definitions
              (filter
               (lambda (c)
                 (define id (candidate-identifier c))
                 (define at (syntax-location id))
                 (and at (member (candidate-kind c) '("variable" "function" "macro"))
                      (equal? (hash-ref at 'source) (environment-path current-env))
                      (= (hash-ref at 'start) (hash-ref params 'start))
                      (= (hash-ref at 'end) (hash-ref params 'end))
                      (equal? (json-value (candidate-phase c)) (hash-ref params 'phaseSpace))
                      (list? (identifier-binding id (candidate-phase c)))))
               (model-candidates current-model))])
         (and (pair? definitions)
              (for/and ([c (in-list definitions)])
                (not (for/or ([export (in-list (model-exports current-model))])
                       (free-identifier=? (candidate-identifier c) (car export)
                                          (candidate-phase c) (cdr export)))))))))

(define (analyze params)
  (set! current-env (make-environment params))
  (set! current-collector (new collector%))
  (set! current-model #f)
  (set! current-mode "module")
  (set! complete? #f)
  (define errors '())
  (call-in-environment
   current-env
   (lambda ()
     (with-handlers ([(lambda (_) #t) (lambda (e) (set! errors (list (failure e))))])
       (define path (environment-path current-env))
       (define original (read-module path (environment-source current-env path)))
       (define parts (syntax->list original))
       (cond
         [(equal? (syntax->datum (third parts)) 'racket/load)
          (set! current-mode "syntax")]
         [else
          (define expanded (expand original))
          (parameterize ([current-annotations current-collector])
            (define-values (accept done) (make-traversal (environment-namespace current-env) (path-only (string->path path))))
            (accept expanded)
            (done))
          (set! current-model (build-model original expanded path))
          (send current-collector add-literal-kinds (model-literals current-model))
          (send current-collector add-applications (model-applications current-model))
          (send current-collector add-source-details (model-details current-model))
          (send current-collector add-macro-kinds (model-candidates current-model))])
       (set! complete? #t))))
  (hasheq 'complete complete? 'annotations (call-in-environment current-env (lambda () (send current-collector all))) 'errors errors
          'mode current-mode
          'imports (if current-model (model-imports current-model) '())
          ;; Plain names survive edits without keeping a worker or stale source
          ;; ranges alive. They are suggestions, not current binding information.
          'completionNames
          (if (and complete? current-model)
              (call-in-environment
               current-env
               (lambda ()
                 (remove-duplicates
                  (for/list ([c (in-list (model-candidates current-model))]
                             #:when (identifier-binding (candidate-identifier c) (candidate-phase c)))
                    (define name (syntax-e (candidate-identifier c)))
                    (hasheq 'name (symbol->string name) 'insert (format "~s" name))))))
              '())
          'completionIssues (if current-model (model-issues current-model) '())
          'dependencies (hash-keys (environment-dependencies current-env))))

(define (completions params)
  (define start (hash-ref params 'start))
  (define end (hash-ref params 'end))
  (define pos (hash-ref params 'position))
  (define prefix (hash-ref params 'prefix ""))
  (call-in-environment
   current-env
   (lambda ()
     (define data current-model)
     (define surrounding
       (sort (filter (lambda (c) (<= (context-start c) pos (context-end c))) (model-contexts data))
             < #:key (lambda (c) (- (context-end c) (context-start c)))))
     (define ctx (and (pair? surrounding) (car surrounding)))
     (define contexts
       (if ctx
           (filter (lambda (c) (and (= (context-start c) (context-start ctx))
                                   (= (context-end c) (context-end ctx)))) surrounding)
           '()))
     (cond
       [(or (not ctx)
            (ormap (lambda (at) (<= (hash-ref at 'start) start end (hash-ref at 'end)))
                   (model-quoted data))) '()]
       [else
        (define seen (make-hash))
        (define phase (context-phase ctx))
        (for/fold ([result '()] #:result (reverse result)) ([c (in-list (model-candidates data))])
          (define name (syntax-e (candidate-identifier c)))
          (define spelling (format "~s" name))
          (define key (list name (candidate-space c)))
          (cond
            [(and (not (hash-has-key? seen key))
                  (string-prefix? spelling prefix)
                  (equal? phase (candidate-phase c))
                  (or (equal? (candidate-origin c) "")
                      (list? (identifier-binding (candidate-identifier c) phase)))
                  (for/and ([context (in-list contexts)])
                    (define reference (datum->syntax (context-syntax context) name))
                    (define scoped-reference
                      (if (candidate-space c)
                          ((make-interned-syntax-introducer (candidate-space c)) reference 'add)
                          reference))
                    (and (equal? phase (context-phase context))
                         (identifier-binding scoped-reference phase)
                         (free-identifier=? scoped-reference (candidate-identifier c) phase))))
             (define kinds
               (remove-duplicates
                (for/list ([other (in-list (candidates-for-binding (model-bindings data) (candidate-identifier c) phase))])
                  (candidate-kind other))))
             (define specific-kinds (if (member "function" kinds) (remove "variable" kinds) kinds))
             (hash-set! seen key #t)
             (cons (hasheq 'name (symbol->string name) 'insert spelling
                           'kind (if (= (length specific-kinds) 1) (car specific-kinds) "identifier") 'origin (candidate-origin c)
                           'phase (json-value phase) 'space (json-value (candidate-space c))) result)]
            [else result]))]))))

(define (dispatch method params)
  (when (and current-env (not (equal? method "analyze")))
    (update-overlays! current-env (hash-ref params 'documents #f)))
  (case (string->symbol method)
    [(analyze) (analyze params)]
    [(complete) (if (and complete? current-model) (completions params) '())]
    [(private-definition)
     (call-in-environment current-env (lambda () (private-definition? params)))]
    [(rename)
     (unless (and complete? (equal? current-mode "module")) (error 'rename "Semantic analysis is unavailable"))
     (define input (open-input-string (hash-ref params 'name)))
     (define name
       (parameterize ([read-accept-reader #f] [read-accept-lang #f]
                      [read-accept-graph #f] [read-accept-compiled #f])
         (define value (read input))
         (unless (and (symbol? value) (eof-object? (read input)))
           (error 'rename "Expected a Racket identifier"))
         value))
     (call-in-environment current-env
       (lambda ()
         (hasheq 'name (symbol->string name) 'text (format "~s" name)
                 'conflicts (send current-collector check-name (hash-ref params 'ids) (symbol->string name)))))]
    [(documentation)
     (call-in-environment current-env
       (lambda ()
         (define tag (send current-collector doc (hash-ref params 'id)))
         (or (fetch-blueboxes-strs tag #:blueboxes-cache boxes) '())))]
    [else (error 'semantic "Unknown request: ~a" method)]))

(define (main)
  (serve dispatch #:dependencies
         (lambda () (and current-env (hash-keys (environment-dependencies current-env))))))
