import React, { useState, useRef, useEffect } from 'react';
import { X, ChevronDown } from 'lucide-react';

interface FilterOption {
  label: string;
  value: string;
}

interface AutocompleteFieldProps {
  label: string;
  placeholder?: string;
  options: FilterOption[];
  selectedValues: string[];
  onChange: (values: string[]) => void;
  isMulti?: boolean;
  icon?: React.ReactNode;
}

export function AutocompleteField({
  label,
  placeholder = 'Buscar...',
  options,
  selectedValues,
  onChange,
  isMulti = true,
  icon
}: AutocompleteFieldProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [filteredOptions, setFilteredOptions] = useState<FilterOption[]>(options);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter options based on search text
  useEffect(() => {
    if (searchText.trim() === '') {
      setFilteredOptions(options);
    } else {
      const lowerSearch = searchText.toLowerCase();
      setFilteredOptions(
        options.filter(
          (option) =>
            option.label.toLowerCase().includes(lowerSearch) ||
            option.value.toLowerCase().includes(lowerSearch)
        )
      );
    }
  }, [searchText, options]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (value: string) => {
    if (isMulti) {
      if (selectedValues.includes(value)) {
        onChange(selectedValues.filter((v) => v !== value));
      } else {
        onChange([...selectedValues, value]);
      }
      setSearchText('');
      inputRef.current?.focus();
    } else {
      onChange([value]);
      setIsOpen(false);
      setSearchText('');
    }
  };

  const handleRemove = (value: string) => {
    onChange(selectedValues.filter((v) => v !== value));
  };

  const selectedLabels = options
    .filter((opt) => selectedValues.includes(opt.value))
    .map((opt) => opt.label);

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-sm font-bold text-zinc-300 mb-2 flex items-center gap-2">
        {icon && <span className="text-blue-400">{icon}</span>}
        {label}
      </label>

      {/* Input Field */}
      <div className="relative">
        <div className="flex items-center gap-2 bg-zinc-800/50 border border-zinc-700 rounded-lg p-3 min-h-[44px] focus-within:border-blue-500 transition-colors cursor-text flex-wrap">
          {/* Selected Values as Chips */}
          {selectedLabels.map((label) => {
            const value = options.find((opt) => opt.label === label)?.value;
            if (!value) return null;
            return (
              <div
                key={value}
                className="flex items-center gap-1 bg-blue-500/20 border border-blue-500/50 rounded-full px-3 py-1 text-xs text-blue-300"
              >
                <span>{label}</span>
                <button
                  onClick={() => handleRemove(value)}
                  className="hover:text-blue-200 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}

          {/* Input */}
          <input
            ref={inputRef}
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onFocus={() => setIsOpen(true)}
            placeholder={selectedValues.length === 0 ? placeholder : ''}
            className="flex-1 min-w-[120px] bg-transparent outline-none text-white placeholder-zinc-500 text-sm"
          />

          {/* Chevron Icon */}
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsOpen(!isOpen);
            }}
            className="p-1 hover:bg-zinc-700 rounded-md transition-colors"
          >
            <ChevronDown
              className={`w-4 h-4 text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
            />
          </button>
        </div>

        {/* Dropdown */}
        {isOpen && (
          <div className="absolute top-full left-0 right-0 mt-2 bg-zinc-800 border border-zinc-700 rounded-lg shadow-lg z-50 max-h-60 overflow-y-auto">
            {filteredOptions.length > 0 ? (
              <div className="py-2">
                {filteredOptions.map((option) => {
                  const isSelected = selectedValues.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      onClick={() => handleSelect(option.value)}
                      className={`w-full text-left px-4 py-2 text-sm transition-colors ${isSelected
                          ? 'bg-blue-500/20 text-blue-300 font-semibold'
                          : 'text-zinc-300 hover:bg-zinc-700/50'
                        }`}
                    >
                      <div className="flex items-center gap-2">
                        {isMulti && (
                          <div
                            className={`w-4 h-4 rounded border-2 transition-colors ${isSelected
                                ? 'bg-blue-500 border-blue-500'
                                : 'border-zinc-500'
                              }`}
                          />
                        )}
                        <span>{option.label}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-4 py-6 text-center text-zinc-500 text-sm">
                No hay resultados para "{searchText}"
              </div>
            )}
          </div>
        )}
      </div>

      {/* Helper Text */}
      {isMulti && (
        <p className="text-xs text-zinc-500 mt-2">
          {selectedValues.length > 0
            ? `${selectedValues.length} seleccionado${selectedValues.length > 1 ? 's' : ''}`
            : 'Selecciona una o más opciones'}
        </p>
      )}
    </div>
  );
}
