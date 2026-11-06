#lang racket/base

(require json net/base64 racket/file racket/list racket/path racket/port racket/string
         syntax/modread)
(provide json-value canonical normalize-text source-name location syntax-location failure
         serve read-module (struct-out environment) make-environment update-overlays!
         call-in-environment environment-source)

(define protocol-in (current-input-port))
(define protocol-out (current-output-port))
(define output-lock (make-semaphore 1))

(define (emit value)
  (call-with-semaphore output-lock
    (lambda () (write-json value protocol-out) (newline protocol-out) (flush-output protocol-out))))

(define (event-port channel)
  (make-output-port
   channel always-evt
   (lambda (bytes start end _non-block? _breakable?)
     (unless (= start end)
       (emit (hasheq 'event "output" 'channel channel
                     'data (bytes->string/latin-1 (base64-encode (subbytes bytes start end) #"")))))
     (- end start))
   void))

(define (json-value value)
  (cond [(or (string? value) (boolean? value) (exact-integer? value)) value]
        [(and (real? value) (rational? value)) (exact->inexact value)]
        [(symbol? value) (symbol->string value)]
        [(path? value) (path->string value)]
        [(null? value) '()]
        [(list? value) (map json-value value)]
        [(pair? value) (hasheq 'car (json-value (car value)) 'cdr (json-value (cdr value)))]
        [(vector? value) (map json-value (vector->list value))]
        [(hash? value)
         (for/hasheq ([(k v) (in-hash value)])
           (values (string->symbol (format "~a" k)) (json-value v)))]
        [else (format "~s" value)]))

(define (canonical path [base (current-directory)])
  (path->string (simplify-path (path->complete-path path base) #f)))

(define (normalize-text text) (regexp-replace* #rx"\r\n?" text "\n"))
(define (source-name value)
  (cond [(and (string? value) (string-prefix? value "racket-source:")) value]
        [(path-string? value) (canonical value)]
        [value (string-append "racket-source:" (format "~s" value))]
        [else #f]))

(define (location source start end)
  (hasheq 'source (source-name source) 'start start 'end end))

(define (syntax-location stx)
  (and (syntax? stx) (syntax-position stx) (syntax-span stx)
       (location (syntax-source stx)
                 (sub1 (syntax-position stx))
                 (+ (sub1 (syntax-position stx)) (syntax-span stx)))))

(define (failure value)
  (define (source-location loc)
    (and (srcloc-position loc)
         (location (srcloc-source loc) (sub1 (srcloc-position loc))
                   (+ (sub1 (srcloc-position loc)) (or (srcloc-span loc) 1)))))
  (define positions
    (cond
      [(exn:fail:syntax? value) (filter-map syntax-location (exn:fail:syntax-exprs value))]
      [(exn:fail:read? value)
       (filter-map source-location (exn:fail:read-srclocs value))]
      [(exn:srclocs? value) (filter-map source-location ((exn:srclocs-accessor value) value))]
      ;; Stack frames describe execution, not the offending source expression.
      ;; Errors without explicit source locations stay unlocated.
      [else '()]))
  (hasheq 'message (if (exn? value) (exn-message value) (format "~s" value))
          'locations positions))

(define (reply id thunk dependencies)
  (define response
    (with-handlers ([(lambda (_) #t) (lambda (e) (hasheq 'id id 'error (failure e)))])
      (hasheq 'id id 'result (thunk))))
  (emit (hash-set response 'dependencies (dependencies))))

(define (serve dispatch #:dependencies [dependencies (lambda () #f)])
  (let loop ()
    (define request (read-json protocol-in))
    (unless (eof-object? request)
      (reply (hash-ref request 'id)
             (lambda ()
               (parameterize ([current-input-port (open-input-string "")]
                              [current-output-port (event-port "stdout")]
                              [current-error-port (event-port "stderr")])
                 (dispatch (hash-ref request 'method) (hash-ref request 'params (hasheq)))))
             dependencies)
      (loop))))

(define (read-module path text)
  (define in (open-input-string (normalize-text text)))
  (port-count-lines! in)
  (with-module-reading-parameterization
   (lambda ()
     (define stx (read-syntax path in))
     (when (eof-object? stx) (error 'read "Empty module"))
     (unless (eof-object? (read-syntax path in)) (error 'read "Expected a single module"))
     (define parts (syntax->list stx))
     (unless (and (pair? parts) (identifier? (car parts)) (eq? (syntax-e (car parts)) 'module))
       (raise-syntax-error 'read "Expected a #lang or module declaration" stx))
     stx)))

;; Each worker owns its namespace and source overlay. Source loading bypasses
;; compiled files for workspace modules, including their unopened dependencies.
(struct environment (namespace path overlays sources dependencies loader) #:transparent)

(define (make-environment params)
  (define path (canonical (hash-ref params 'path)))
  (define overlays (make-hash))
  (for ([entry (in-list (hash-ref params 'documents '()))])
    (hash-set! overlays (canonical (hash-ref entry 'path))
               (normalize-text (hash-ref entry 'text))))
  (hash-set! overlays path (normalize-text (hash-ref params 'text)))
  (define roots
    (for/list ([root (in-list (hash-ref params 'roots '()))])
      (path->string (path->directory-path (canonical root)))))
  (define sources (hash-copy overlays))
  (define dependencies (make-hash))
  (define original-loader (current-load/use-compiled))
  (define (workspace-path? p)
    (for/or ([root (in-list roots)])
      (string-prefix? p root)))
  (define (loader filename expected)
    (define full (canonical filename))
    (hash-set! dependencies full #t)
    (cond
      [(and expected (or (hash-has-key? overlays full)
                         (and (workspace-path? full) (file-exists? full))))
       (define text (hash-ref! sources full (lambda () (normalize-text (file->string full)))))
       (parameterize ([current-load-relative-directory (path-only (string->path full))]
                      [current-module-declare-source (string->path full)])
         ;; Like Racket's source loader, bind the outer `module` identifier
         ;; independently of the namespace that requested this dependency.
         (eval-syntax (check-module-form (read-module full text) expected full)))]
      [else (original-loader filename expected)]))
  (environment (make-base-namespace) path overlays sources dependencies loader))

;; Retained workers may first read an unrelated editor buffer in a later
;; callback. Refresh unread overlays before that callback, not their namespaces.
(define (update-overlays! env documents)
  (when documents
    (define overlays (environment-overlays env))
    (define sources (environment-sources env))
    (define path (environment-path env))
    (define own-text (hash-ref sources path))
    (for ([key (in-hash-keys overlays)]) (hash-remove! sources key))
    (hash-clear! overlays)
    (for ([entry (in-list documents)])
      (define full (canonical (hash-ref entry 'path)))
      (define text (normalize-text (hash-ref entry 'text)))
      (hash-set! overlays full text)
      (hash-set! sources full text))
    (hash-set! overlays path own-text)
    (hash-set! sources path own-text)))

(define (call-in-environment env thunk)
  (define directory (path-only (string->path (environment-path env))))
  (define parent (current-security-guard))
  (define recording? #f)
  (define guard
    (make-security-guard
     parent
     (lambda (_who path modes)
       (when (and path (not recording?) (or (memq 'read modes) (memq 'exists modes)))
         (set! recording? #t)
         (hash-set! (environment-dependencies env) (canonical path) #t)
         (set! recording? #f)))
     (lambda _ (void))))
  (parameterize ([current-namespace (environment-namespace env)]
                 [current-directory directory]
                 [current-load-relative-directory directory]
                 [current-load/use-compiled (environment-loader env)]
                 [current-security-guard guard])
    (thunk)))

(define (environment-source env source)
  (hash-ref! (environment-sources env) source
             (lambda () (normalize-text (file->string source)))))
